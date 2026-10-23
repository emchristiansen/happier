import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import {
  readSessionUserMessageAdmissionBody,
  type SessionUserMessageAdmissionBody,
} from '@/session/services/admitSessionUserMessage';

/**
 * Keeps the exact admission body first issued under a (session, localId), so
 * that a resend of the same request under the same localId issues
 * byte-identical bytes.
 *
 * The relay answers an identical re-enqueue with the existing row, but refuses
 * a changed one. Without this store a resend re-seals the message under the
 * target's current model and permission metadata, so a metadata change between
 * attempts turns a retry of a committed message into a refusal.
 *
 * Publication: each (session, localId) has one pathname. The first publisher
 * wins through an exclusive `link` of a complete file; a later attempt of the
 * same request (same fingerprint) reads and issues the winner. An attempt with
 * a different request under the same localId (a reused `--local-id`) issues its
 * own body and leaves the kept one in place.
 *
 * Removal is fenced by generation. Every published file carries a random
 * `generation`. A remover decides on one (pathname, generation), then
 * atomically renames the pathname to a private quarantine name and reads what
 * it actually moved. Only the decided generation is unlinked. Anything else (a
 * body republished at that pathname after another remover deleted the old one)
 * is linked back; if a third body was published in that instant, the moved
 * one is dropped and the newer one stays. A remover therefore never deletes a
 * generation it did not judge.
 *
 * Bounds, applied on every publication: bodies older than
 * `SESSION_SEND_ADMISSION_RETENTION_MS` are removed; above
 * `SESSION_SEND_ADMISSION_MAX_ENTRIES` the oldest by `storedAtMs` are evicted;
 * temporary files older than the retention (left by a crash) are removed. A
 * kept body older than the retention is not re-issued.
 */

export const SESSION_SEND_ADMISSION_RETENTION_MS = 60 * 60_000;
export const SESSION_SEND_ADMISSION_MAX_ENTRIES = 256;

const DIRECTORY_NAME = 'session-send-admissions';
const ENTRY_SUFFIX = '.json';
const TMP_PREFIX = '.tmp-';
const QUARANTINE_PREFIX = '.quarantine-';

type StoredAdmission = Readonly<{
  v: 1;
  generation: string;
  sessionId: string;
  requestFingerprint: string;
  storedAtMs: number;
  body: SessionUserMessageAdmissionBody;
}>;

type StoreOptions = Readonly<{
  nowMs?: () => number;
  /** Test seam: runs after a remover has decided on a generation and before it moves it. */
  beforeRemove?: (entryName: string) => Promise<void>;
}>;

function resolveDirectory(): string {
  return join(configuration.activeServerDir, DIRECTORY_NAME);
}

function resolveEntryName(sessionId: string, localId: string): string {
  const name = createHash('sha256').update(JSON.stringify(['session-send-admission-v1', sessionId, localId])).digest('hex');
  return `${name}${ENTRY_SUFFIX}`;
}

function isEntryName(name: string): boolean {
  return name.endsWith(ENTRY_SUFFIX) && !name.startsWith('.');
}

function parseStoredAdmission(raw: string): StoredAdmission | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const body = readSessionUserMessageAdmissionBody(record.body);
  if (record.v !== 1 || typeof record.generation !== 'string' || typeof record.sessionId !== 'string'
    || typeof record.requestFingerprint !== 'string' || typeof record.storedAtMs !== 'number' || !body) return null;
  return {
    v: 1,
    generation: record.generation,
    sessionId: record.sessionId,
    requestFingerprint: record.requestFingerprint,
    storedAtMs: record.storedAtMs,
    body,
  };
}

async function readStoredAdmission(path: string): Promise<StoredAdmission | null | 'unreadable'> {
  try {
    return parseStoredAdmission(await readFile(path, 'utf8')) ?? 'unreadable';
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

/**
 * Removes `entryName` only if it still holds `generation` (null: an unreadable
 * file). Returns whether that generation was removed.
 */
async function removeGeneration(
  directory: string,
  entryName: string,
  generation: string | null,
  options: StoreOptions,
): Promise<boolean> {
  await options.beforeRemove?.(entryName);
  const path = join(directory, entryName);
  const quarantinePath = join(directory, `${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await readStoredAdmission(quarantinePath);
  const movedGeneration = moved === null ? undefined : moved === 'unreadable' ? null : moved.generation;
  if (movedGeneration === generation) {
    await unlinkIfPresent(quarantinePath);
    return true;
  }
  // Not the generation this remover judged: put it back, unless a newer body
  // was already published at the pathname, which then stays.
  try {
    await link(quarantinePath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  } finally {
    await unlinkIfPresent(quarantinePath);
  }
  return false;
}

async function enforceBounds(directory: string, nowMs: number, options: StoreOptions): Promise<void> {
  const live: Array<Readonly<{ name: string; generation: string; storedAtMs: number }>> = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (name.startsWith(TMP_PREFIX) || name.startsWith(QUARANTINE_PREFIX)) {
      // Private to one writer for milliseconds; older than the retention means
      // its writer died. Names are unique per writer, so no generation applies.
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (info && nowMs - info.mtimeMs > SESSION_SEND_ADMISSION_RETENTION_MS) await unlinkIfPresent(path);
      continue;
    }
    if (!isEntryName(name)) continue;
    const stored = await readStoredAdmission(path);
    if (stored === null) continue;
    if (stored === 'unreadable') {
      await removeGeneration(directory, name, null, options);
      continue;
    }
    if (nowMs - stored.storedAtMs > SESSION_SEND_ADMISSION_RETENTION_MS) {
      await removeGeneration(directory, name, stored.generation, options);
      continue;
    }
    live.push({ name, generation: stored.generation, storedAtMs: stored.storedAtMs });
  }
  // Leave room for the body about to be published.
  live.sort((a, b) => a.storedAtMs - b.storedAtMs || a.name.localeCompare(b.name));
  let excess = live.length - (SESSION_SEND_ADMISSION_MAX_ENTRIES - 1);
  for (const entry of live) {
    if (excess <= 0) break;
    if (await removeGeneration(directory, entry.name, entry.generation, options)) excess -= 1;
  }
}

/** A stable digest of the caller's request inputs. */
export function fingerprintSessionSendRequest(inputs: unknown): string {
  return createHash('sha256').update(JSON.stringify(['session-send-request-v1', inputs])).digest('hex');
}

/**
 * Returns the body to issue: the one kept for (sessionId, localId) and this
 * request within the retention, else `candidate`, which it keeps if no body
 * is kept for that pathname.
 */
export async function preserveSessionSendAdmission(params: Readonly<{
  sessionId: string;
  requestFingerprint: string;
  candidate: SessionUserMessageAdmissionBody;
}> & StoreOptions): Promise<SessionUserMessageAdmissionBody> {
  const now = params.nowMs ?? Date.now;
  const localId = params.candidate.localId;
  const directory = resolveDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entryName = resolveEntryName(params.sessionId, localId);
  const path = join(directory, entryName);

  const currentOf = (stored: StoredAdmission | null | 'unreadable'): StoredAdmission | null =>
    stored !== null && stored !== 'unreadable'
    && stored.sessionId === params.sessionId && stored.body.localId === localId
    && now() - stored.storedAtMs <= SESSION_SEND_ADMISSION_RETENTION_MS
      ? stored
      : null;
  const choose = (stored: StoredAdmission) =>
    stored.requestFingerprint === params.requestFingerprint ? stored.body : params.candidate;

  const existing = currentOf(await readStoredAdmission(path));
  if (existing) return choose(existing);

  await enforceBounds(directory, now(), params);
  const record: StoredAdmission = {
    v: 1,
    generation: randomUUID(),
    sessionId: params.sessionId,
    requestFingerprint: params.requestFingerprint,
    storedAtMs: now(),
    body: params.candidate,
  };
  const tmpPath = join(directory, `${TMP_PREFIX}${process.pid}-${randomUUID()}${ENTRY_SUFFIX}`);
  await writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(tmpPath, path);
        return params.candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
      const winner = await readStoredAdmission(path);
      const currentWinner = currentOf(winner);
      if (currentWinner) return choose(currentWinner);
      // A stale or unreadable body that bound enforcement did not remove: remove that generation and retry.
      if (winner !== null) {
        await removeGeneration(directory, entryName, winner === 'unreadable' ? null : winner.generation, params);
      }
    }
    throw new Error('session_send_admission_store_contended');
  } finally {
    await unlinkIfPresent(tmpPath);
  }
}
