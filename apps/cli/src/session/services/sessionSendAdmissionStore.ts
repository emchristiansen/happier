import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import {
  readSessionUserMessageAdmissionBody,
  type SessionUserMessageAdmissionBody,
} from '@/session/services/admitSessionUserMessage';

/**
 * Keeps the exact admission body first issued under a (session, localId), so
 * that a resend under the same localId issues byte-identical bytes.
 *
 * The relay answers an identical re-enqueue with the existing row, but refuses
 * (409) a changed one. Without this store a resend re-seals the message under
 * the target's current model and permission metadata, so a metadata change
 * between attempts turns a retry of a committed message into a refusal.
 *
 * Each (session, localId) has one write-once file. The first publisher wins
 * through an exclusive `link`; every later attempt of the same request reads
 * and issues the winner. The file records a fingerprint of the caller's
 * request (text, action, overrides): an attempt with a different request under
 * the same localId (a reused `--local-id`) issues its own body, which the relay
 * refuses as a conflict, rather than silently re-sending the old message.
 * Files are never rewritten, so there is no generation to fence. Files older
 * than `SESSION_SEND_ADMISSION_RETENTION_MS` are removed when another body is
 * published; a resend after that re-seals.
 */

export const SESSION_SEND_ADMISSION_RETENTION_MS = 60 * 60_000;

const DIRECTORY_NAME = 'session-send-admissions';

type StoredAdmission = Readonly<{
  v: 1;
  sessionId: string;
  requestFingerprint: string;
  storedAtMs: number;
  body: SessionUserMessageAdmissionBody;
}>;

function resolveDirectory(): string {
  return join(configuration.activeServerDir, DIRECTORY_NAME);
}

function resolvePath(directory: string, sessionId: string, localId: string): string {
  const name = createHash('sha256').update(JSON.stringify(['session-send-admission-v1', sessionId, localId])).digest('hex');
  return join(directory, `${name}.json`);
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
  if (record.v !== 1 || typeof record.sessionId !== 'string' || typeof record.requestFingerprint !== 'string'
    || typeof record.storedAtMs !== 'number' || !body) return null;
  return {
    v: 1,
    sessionId: record.sessionId,
    requestFingerprint: record.requestFingerprint,
    storedAtMs: record.storedAtMs,
    body,
  };
}

async function readStoredAdmission(path: string): Promise<StoredAdmission | null> {
  try {
    return parseStoredAdmission(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeExpired(directory: string, nowMs: number): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json') || name.startsWith('.tmp-')) continue;
    const path = join(directory, name);
    const stored = await readStoredAdmission(path);
    if (stored !== null && nowMs - stored.storedAtMs <= SESSION_SEND_ADMISSION_RETENTION_MS) continue;
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

/** A stable digest of the caller's request inputs. */
export function fingerprintSessionSendRequest(inputs: unknown): string {
  return createHash('sha256').update(JSON.stringify(['session-send-request-v1', inputs])).digest('hex');
}

/**
 * Returns the body to issue: the one already kept for (sessionId, localId) and
 * this request, else `candidate`, which it keeps if nothing is kept yet.
 */
export async function preserveSessionSendAdmission(params: Readonly<{
  sessionId: string;
  requestFingerprint: string;
  candidate: SessionUserMessageAdmissionBody;
  nowMs?: () => number;
}>): Promise<SessionUserMessageAdmissionBody> {
  const now = params.nowMs ?? Date.now;
  const localId = params.candidate.localId;
  const directory = resolveDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolvePath(directory, params.sessionId, localId);

  const matches = (stored: StoredAdmission | null): stored is StoredAdmission =>
    stored !== null && stored.sessionId === params.sessionId && stored.body.localId === localId;

  const existing = await readStoredAdmission(path);
  if (matches(existing)) {
    return existing.requestFingerprint === params.requestFingerprint ? existing.body : params.candidate;
  }

  await removeExpired(directory, now());
  const record: StoredAdmission = {
    v: 1,
    sessionId: params.sessionId,
    requestFingerprint: params.requestFingerprint,
    storedAtMs: now(),
    body: params.candidate,
  };
  const tmpPath = join(directory, `.tmp-${process.pid}-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 });
  try {
    await link(tmpPath, path);
    return params.candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    const winner = await readStoredAdmission(path);
    if (matches(winner)) return winner.requestFingerprint === params.requestFingerprint ? winner.body : params.candidate;
    throw new Error('session_send_admission_store_unreadable');
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}
