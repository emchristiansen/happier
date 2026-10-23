import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readPendingLocalId, type PendingRequestedActionV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
  readSessionUserMessageAdmissionBody,
  type SessionUserMessageAdmissionBody,
} from '@/session/services/admitSessionUserMessage';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

/**
 * Chooses the Pending localId for a `session.message.send` that the caller did
 * not key itself, so that a retry of a send whose outcome the caller never
 * learned becomes the same relay row instead of a second message.
 *
 * The relay already deduplicates Pending and transcript rows by
 * (session, localId); a send is idempotent exactly when its retries reuse the
 * localId. Two identities make a retry recognisable:
 *
 * 1. A provider tool-call id (Claude's `_meta["claudecode/toolUseId"]`, Pi's
 *    tool call id). A provider retry of the same call carries the same id, so
 *    the localId is a digest of it and of the sender session: deterministic, no
 *    local state needed for that case.
 * 2. The retry ledger, for everything else (`happier session send` without
 *    `--local-id`, Codex tool calls, which expose no call id, and a NEW tool call
 *    that repeats the same text after a failure). It remembers, per sender and
 *    exact send inputs, the localId of the last attempt that did not end in
 *    success, for `SESSION_SEND_RETRY_WINDOW_MS` after that attempt. An identical
 *    send inside the window reuses it; a success removes it.
 *
 * The entry also keeps the exact admission body first issued under its localId
 * (`preserveAdmission`). A retry re-issues those bytes, not a re-sealing under
 * the target's current model or permission metadata: the relay answers an
 * identical re-enqueue with the existing row, but refuses a changed one, and
 * a refused retry would let the next identical send mint a fresh localId.
 *
 * Why not a pure (target, text) digest: agents send identical texts on purpose
 * ("READY TO MOVE", repeated status lines). With a fixed digest the relay would
 * answer every later copy with the first row and report success, silently
 * dropping it. The ledger separates the two cases by the one fact that defines a
 * retry: the previous identical attempt did not report success. A deliberate
 * repeat after a successful send therefore always gets a fresh localId.
 */

/**
 * How long after an unsuccessful attempt an identical send counts as its retry.
 * Every unsuccessful attempt re-arms it, so a retry loop of any length keeps one
 * localId; a deliberate repeat after this much quiet time is a new message.
 */
export const SESSION_SEND_RETRY_WINDOW_MS = 10 * 60_000;

export const SESSION_SEND_TOOL_CALL_LOCAL_ID_PREFIX = 'session-send-tool-call:';

const LEDGER_DIRECTORY_NAME = 'session-send-retry-ledger';

export type SessionSendRetryIdentity = Readonly<{
  /** The session (or `cli-global`) on whose behalf the send runs. */
  senderSessionId: string;
  /** Provider-assigned id of the invoking tool call; null when the transport exposes none. */
  providerToolCallId: string | null;
}>;

/** Everything that decides what an attempt enqueues, as the caller supplied it. */
export type SessionSendRetryInputs = Readonly<{
  target: string;
  message: string;
  requestedAction: PendingRequestedActionV1 | null;
  permissionModeOverride: string | null;
  modelOverride: Readonly<{ set: false }> | Readonly<{ set: true; value: string | null }>;
  pendingAdmissionMode: string | null;
}>;

export type SessionSendAttemptOutcome =
  /** The caller is told the send succeeded. */
  | 'succeeded'
  /** The relay answered definitively and created nothing under this localId. */
  | 'refused'
  /** Anything else: the caller may retry, and the retry must reuse the localId. */
  | 'unsuccessful';

export type ClaimedSessionSendLocalId = Readonly<{
  localId: string;
  /**
   * Returns the admission body to issue for `sessionId`: the one already kept
   * for this localId and session, else `candidate`, which it keeps first.
   */
  preserveAdmission: (sessionId: string, candidate: SessionUserMessageAdmissionBody) => Promise<SessionUserMessageAdmissionBody>;
  settle: (outcome: SessionSendAttemptOutcome) => Promise<void>;
}>;

type LedgerAdmission = Readonly<{ sessionId: string; body: SessionUserMessageAdmissionBody }>;

type LedgerEntry = Readonly<{ v: 1; localId: string; lastAttemptAtMs: number; admission?: LedgerAdmission }>;

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildRetryKeyMaterial(identity: SessionSendRetryIdentity, inputs: SessionSendRetryInputs): unknown[] {
  return [
    identity.senderSessionId,
    inputs.target,
    inputs.message,
    inputs.requestedAction,
    inputs.permissionModeOverride,
    inputs.modelOverride.set ? ['set', inputs.modelOverride.value] : ['unset'],
    inputs.pendingAdmissionMode,
  ];
}

export function deriveSessionSendToolCallLocalId(
  identity: SessionSendRetryIdentity & { providerToolCallId: string },
  inputs: SessionSendRetryInputs,
): string {
  const digest = sha256Hex([
    'session-send-tool-call-v1',
    identity.providerToolCallId,
    ...buildRetryKeyMaterial(identity, inputs),
  ]).slice(0, 32);
  const localId = readPendingLocalId(`${SESSION_SEND_TOOL_CALL_LOCAL_ID_PREFIX}${digest}`);
  if (localId === null) throw new Error('session_send_tool_call_local_id_invalid');
  return localId;
}

function resolveLedgerDirectory(): string {
  return join(configuration.activeServerDir, LEDGER_DIRECTORY_NAME);
}

function readLedgerEntry(raw: string): LedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const localId = readPendingLocalId(record.localId);
  const lastAttemptAtMs = record.lastAttemptAtMs;
  if (record.v !== 1 || localId === null || typeof lastAttemptAtMs !== 'number' || !Number.isFinite(lastAttemptAtMs)) {
    return null;
  }
  const admission = readLedgerAdmission(record.admission, localId);
  return { v: 1, localId, lastAttemptAtMs, ...(admission ? { admission } : {}) };
}

function readLedgerAdmission(value: unknown, localId: string): LedgerAdmission | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : null;
  const body = readSessionUserMessageAdmissionBody(record.body);
  return sessionId && body && body.localId === localId ? { sessionId, body } : null;
}

async function readEntryFile(path: string): Promise<LedgerEntry | null> {
  try {
    return readLedgerEntry(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function isLive(entry: LedgerEntry | null, nowMs: number): entry is LedgerEntry {
  return entry !== null && nowMs - entry.lastAttemptAtMs <= SESSION_SEND_RETRY_WINDOW_MS;
}

/** Publish a complete entry only if none exists; concurrent claimers converge on one localId. */
async function publishEntryIfAbsent(directory: string, path: string, entry: LedgerEntry): Promise<boolean> {
  const tmpPath = join(directory, `.tmp-${process.pid}-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(entry), { mode: 0o600 });
  try {
    await link(tmpPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

async function removeExpiredEntries(directory: string, nowMs: number): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json') || name.startsWith('.tmp-')) continue;
    const path = join(directory, name);
    const entry = await readEntryFile(path);
    if (entry !== null && isLive(entry, nowMs)) continue;
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export async function claimSessionSendLocalId(params: Readonly<{
  identity: SessionSendRetryIdentity;
  inputs: SessionSendRetryInputs;
  nowMs?: () => number;
}>): Promise<ClaimedSessionSendLocalId> {
  const now = params.nowMs ?? Date.now;
  const directory = resolveLedgerDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await removeExpiredEntries(directory, now());

  const path = join(directory, `${sha256Hex(['session-send-retry-v1', ...buildRetryKeyMaterial(params.identity, params.inputs)])}.json`);
  const freshLocalId = () => params.identity.providerToolCallId
    ? deriveSessionSendToolCallLocalId({ ...params.identity, providerToolCallId: params.identity.providerToolCallId }, params.inputs)
    : randomUUID();

  let localId: string;
  let admission: LedgerAdmission | null = null;
  const existing = await readEntryFile(path);
  if (isLive(existing, now())) {
    localId = existing.localId;
    admission = existing.admission ?? null;
  } else if (existing === null) {
    const candidate: LedgerEntry = { v: 1, localId: freshLocalId(), lastAttemptAtMs: now() };
    if (await publishEntryIfAbsent(directory, path, candidate)) {
      localId = candidate.localId;
    } else {
      const winner = await readEntryFile(path);
      localId = isLive(winner, now()) ? winner.localId : candidate.localId;
      admission = isLive(winner, now()) ? winner.admission ?? null : null;
    }
  } else {
    localId = freshLocalId();
  }
  const writeEntry = async () => await writeJsonAtomic(path, {
    v: 1,
    localId,
    lastAttemptAtMs: now(),
    ...(admission ? { admission } : {}),
  } satisfies LedgerEntry);
  // Persist before the first possible issuance: a process killed mid-attempt
  // must leave the localId for its retry to find.
  await writeEntry();

  return {
    localId,
    preserveAdmission: async (sessionId, candidate) => {
      if (candidate.localId !== localId) throw new Error('session_send_admission_identity_changed');
      if (admission && admission.sessionId === sessionId) return admission.body;
      // A different session behind the same typed target has no committed
      // bytes under this localId to reconcile with; keep the first session's.
      if (admission) return candidate;
      admission = { sessionId, body: candidate };
      // Persist before the first issuance, so a retry re-sends these bytes.
      await writeEntry();
      return candidate;
    },
    settle: async (outcome) => {
      const current = await readEntryFile(path);
      if (current !== null && current.localId !== localId) return;
      if (outcome === 'unsuccessful') {
        await writeEntry();
        return;
      }
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    },
  };
}
