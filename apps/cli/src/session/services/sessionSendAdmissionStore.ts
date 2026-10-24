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
 * Body names are unique and never reused or overwritten. Cleanup can remove
 * an expired or evicted body, but removing an old body's name cannot remove a
 * replacement body. Two kinds of immutable file exist per key:
 *
 * - A body, `<key>.<storedAtMs>-<uuid>.json`, holds one attempt's admission
 *   body. Its name is unique to the attempt that wrote it and is never reused.
 * - A decision, `<key>.<window>.<n>.decision`, names the body that every
 *   attempt in that window issues. `window` is `floor(nowMs / retention)`. It
 *   is published with an exclusive `link`, so of two attempts racing for one
 *   decision name exactly one wins; the loser adopts the winner's body. `n`
 *   counts decisions within a window: a new one is made only when the body of
 *   the highest one is no longer current.
 *
 * An attempt reads the decisions of the previous, its current and the next
 * window, and writes only in its current window. A current body named by a
 * decision in the next sampled window takes precedence. It can determine a
 * return only if the iteration starts and ends in the same window. Such a
 * return requires a backward boundary crossing; the decision may have been
 * linked after that crossing by a writer that sampled the later window
 * earlier. Otherwise the highest decision of the current window governs, and
 * without one the highest of the previous window, which is first re-published
 * in the current window. A decision determines a return only when it is in
 * the attempt's current or next window and the iteration starts and ends in
 * the same window. A paused writer can still link a
 * decision under a window name it read earlier; it then reads again, so that
 * decision determines its return only through these rules. While the host
 * clock does not step back across a window boundary, the decisions any two
 * returns rely on therefore share one exclusive name, or are ordered through
 * it, so attempts of one request issue the same body while that body stays
 * current (unexpired and not evicted).
 *
 * Known limit: a backward clock step across a window boundary, while a first
 * publication is in flight, can make two attempts at one key return different
 * bodies. An attempt that sampled window W+1 and paused before its link can
 * link after the clock stepped back and another attempt, now in W, published
 * and returned its own body; the W+1 decision then governs the first
 * attempt's next read. The two decision names differ, so no exclusive link
 * arbitrates between them. A rollback that moves a retained decision beyond
 * the adjacent windows scanned can also cause resealing. For the same request
 * and unchanged encryption context, deterministic sealing yields identical
 * bodies unless the resolved model or permission metadata differs; the trace
 * above needs such a change between the two preparations. The relay then
 * refuses the later send (409 while the first is queued, 400 once it is in
 * the transcript), so it is never duplicated.
 *
 * Removal, applied after a publication: bodies older than the retention, then
 * the oldest bodies beyond `SESSION_SEND_ADMISSION_MAX_ENTRIES` (by
 * storedAtMs, then name); decisions two or more windows behind the remover's
 * sampled window, which a reader includes only if its sampled iteration
 * window is at least one behind the remover's sampled window;
 * temporary files whose mtime is older than the retention, the cleanup
 * criterion for a write that never completed. Every removal names one unique
 * file. A decision whose body was removed counts as not current.
 */

export const SESSION_SEND_ADMISSION_RETENTION_MS = 60 * 60_000;
export const SESSION_SEND_ADMISSION_MAX_ENTRIES = 256;

const DIRECTORY_NAME = 'session-send-admissions';
const TMP_PREFIX = '.tmp-';
const MAX_ATTEMPTS = 8;

const BODY_NAME = /^([0-9a-f]{64})\.(\d+)-([0-9a-f-]{36})\.json$/;
const DECISION_NAME = /^([0-9a-f]{64})\.(\d+)\.(\d+)\.decision$/;

type StoredAdmission = Readonly<{
  v: 2;
  sessionId: string;
  requestFingerprint: string;
  storedAtMs: number;
  body: SessionUserMessageAdmissionBody;
}>;

type Decision = Readonly<{ name: string; window: number; n: number }>;

type StoreOptions = Readonly<{
  nowMs?: () => number;
  /** Test seam: runs before a removal unlinks the file it judged. */
  beforeRemove?: (fileName: string) => Promise<void>;
  /** Test seam: runs before an attempt links a decision. */
  beforeLink?: () => Promise<void>;
}>;

function resolveDirectory(): string {
  return join(configuration.activeServerDir, DIRECTORY_NAME);
}

function resolveKey(sessionId: string, localId: string): string {
  return createHash('sha256').update(JSON.stringify(['session-send-admission-v2', sessionId, localId])).digest('hex');
}

function windowOf(nowMs: number): number {
  return Math.floor(nowMs / SESSION_SEND_ADMISSION_RETENTION_MS);
}

function parseBodyName(name: string): Readonly<{ key: string; storedAtMs: number }> | null {
  const match = BODY_NAME.exec(name);
  return match ? { key: match[1]!, storedAtMs: Number(match[2]) } : null;
}

function parseDecisionName(name: string): Readonly<{ key: string; window: number; n: number }> | null {
  const match = DECISION_NAME.exec(name);
  return match ? { key: match[1]!, window: Number(match[2]), n: Number(match[3]) } : null;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
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
  if (record.v !== 2 || typeof record.sessionId !== 'string' || typeof record.requestFingerprint !== 'string'
    || typeof record.storedAtMs !== 'number' || !body) return null;
  return { v: 2, sessionId: record.sessionId, requestFingerprint: record.requestFingerprint, storedAtMs: record.storedAtMs, body };
}

function parseDecisionBodyName(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parsed && parsed.v === 2 && typeof parsed.bodyName === 'string' && BODY_NAME.test(parsed.bodyName)
      ? parsed.bodyName
      : null;
  } catch {
    return null;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function writeTmp(directory: string, contents: string): Promise<string> {
  const tmpPath = join(directory, `${TMP_PREFIX}${process.pid}-${randomUUID()}`);
  await writeFile(tmpPath, contents, { mode: 0o600 });
  return tmpPath;
}

/** Publishes `contents` at `name` only if nothing is there; returns whether it did. */
async function linkExclusive(directory: string, name: string, contents: string): Promise<boolean> {
  const tmpPath = await writeTmp(directory, contents);
  try {
    await link(tmpPath, join(directory, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlinkIfPresent(tmpPath);
  }
}

async function removeJudged(directory: string, name: string, options: StoreOptions): Promise<void> {
  await options.beforeRemove?.(name);
  await unlinkIfPresent(join(directory, name));
}

async function enforceBounds(directory: string, nowMs: number, options: StoreOptions): Promise<void> {
  const currentWindow = windowOf(nowMs);
  const live: Array<Readonly<{ name: string; storedAtMs: number }>> = [];
  for (const name of await readdir(directory)) {
    if (name.startsWith(TMP_PREFIX)) {
      // The cleanup criterion for a write that never completed; not proof
      // that its writer is gone.
      const info = await stat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (info && nowMs - info.mtimeMs > SESSION_SEND_ADMISSION_RETENTION_MS) await removeJudged(directory, name, options);
      continue;
    }
    const decision = parseDecisionName(name);
    if (decision) {
      if (decision.window <= currentWindow - 2) await removeJudged(directory, name, options);
      continue;
    }
    const body = parseBodyName(name);
    if (!body) continue;
    if (nowMs - body.storedAtMs > SESSION_SEND_ADMISSION_RETENTION_MS) {
      await removeJudged(directory, name, options);
      continue;
    }
    live.push({ name, storedAtMs: body.storedAtMs });
  }
  live.sort((a, b) => a.storedAtMs - b.storedAtMs || a.name.localeCompare(b.name));
  for (const entry of live.slice(0, Math.max(0, live.length - SESSION_SEND_ADMISSION_MAX_ENTRIES))) {
    await removeJudged(directory, entry.name, options);
  }
}

/** A stable digest of the caller's request inputs. */
export function fingerprintSessionSendRequest(inputs: unknown): string {
  return createHash('sha256').update(JSON.stringify(['session-send-request-v1', inputs])).digest('hex');
}

/**
 * Returns the body to issue: the body decided for (sessionId, localId) while
 * it is current, if it was stored for this request, else `candidate`. When no
 * body is current, `candidate` becomes the decided body.
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
  const key = resolveKey(params.sessionId, localId);

  const readCurrent = async (bodyName: string): Promise<StoredAdmission | null> => {
    const raw = await readIfPresent(join(directory, bodyName));
    const stored = raw === null ? null : parseStoredAdmission(raw);
    return stored && stored.sessionId === params.sessionId && stored.body.localId === localId
      && now() - stored.storedAtMs <= SESSION_SEND_ADMISSION_RETENTION_MS
      ? stored
      : null;
  };
  const choose = (stored: StoredAdmission) =>
    stored.requestFingerprint === params.requestFingerprint ? stored.body : params.candidate;

  // This attempt's own body, written at most once and removed unless decided.
  let ownBodyName: string | null = null;
  let ownBodyDecided = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const window = windowOf(now());
      // The highest decision of the previous, this and the next window.
      const tops = new Map<number, Decision>();
      for (const name of await readdir(directory)) {
        const parsed = parseDecisionName(name);
        if (!parsed || parsed.key !== key || parsed.window < window - 1 || parsed.window > window + 1) continue;
        const known = tops.get(parsed.window);
        if (!known || parsed.n > known.n) tops.set(parsed.window, { name, window: parsed.window, n: parsed.n });
      }
      const resolve = async (decision: Decision | undefined) => {
        if (!decision) return null;
        const bodyName = parseDecisionBodyName((await readIfPresent(join(directory, decision.name))) ?? '');
        const stored = bodyName ? await readCurrent(bodyName) : null;
        return bodyName && stored ? { decision, bodyName, stored } : null;
      };
      // A current body named by a decision in the next sampled window takes
      // precedence. It can determine a return only if the iteration starts and
      // ends in the same window. Such a return requires a backward boundary
      // crossing; the decision may have been linked after that crossing by a
      // writer that sampled the later window earlier (the known limit above).
      // Otherwise this window's highest decision governs, and only without one
      // the previous window's.
      const top = tops.get(window) ?? tops.get(window - 1);
      const decided = (await resolve(tops.get(window + 1))) ?? (await resolve(top));
      const decidedBodyName = decided?.bodyName ?? null;

      if (decided && decided.decision.window >= window) {
        // A window change during the read means the decision must first be
        // carried into the new window.
        if (windowOf(now()) !== window) continue;
        if (decidedBodyName === ownBodyName) ownBodyDecided = true;
        return choose(decided.stored);
      }

      // Record a decision in this window: the previous window's current body,
      // or else this attempt's own.
      let bodyName: string | null = decidedBodyName ?? ownBodyName;
      if (!bodyName) {
        const storedAtMs = now();
        const record: StoredAdmission = {
          v: 2,
          sessionId: params.sessionId,
          requestFingerprint: params.requestFingerprint,
          storedAtMs,
          body: params.candidate,
        };
        ownBodyName = `${key}.${storedAtMs}-${randomUUID()}.json`;
        const tmpPath = await writeTmp(directory, JSON.stringify(record));
        await rename(tmpPath, join(directory, ownBodyName));
        bodyName = ownBodyName;
      }
      // Decisions are written only in this window, never the next.
      const n = (tops.get(window)?.n ?? -1) + 1;
      await params.beforeLink?.();
      const linked = await linkExclusive(directory, `${key}.${window}.${n}.decision`, JSON.stringify({ v: 2, bodyName }));
      if (linked && bodyName === ownBodyName) {
        ownBodyDecided = true;
        // Bound the store after this body is in place, so the bound holds once
        // every concurrent publication has returned.
        await enforceBounds(directory, now(), params);
      }
      // Re-read: the next pass returns the decision if the window held.
    }
    throw new Error('session_send_admission_store_contended');
  } finally {
    if (ownBodyName && !ownBodyDecided) await unlinkIfPresent(join(directory, ownBodyName));
  }
}
