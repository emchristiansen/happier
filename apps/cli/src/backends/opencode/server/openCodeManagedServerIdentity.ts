import { createHash } from 'node:crypto';

import type { SharedManagedOpenCodeServerState } from './sharedManagedServer';

/**
 * Stable, redactable identity for a managed `opencode serve` process.
 *
 * The `generationKey` changes whenever the underlying server process is replaced (new managed
 * start). It is the runtime-facing "which process am I talking to?" identity and is DISTINCT from
 * the launch fingerprint (which determines server REUSE/selection — see
 * `openCodeManagedServerEnv.resolveOpenCodeManagedServerLaunchFingerprint`). A launch fingerprint
 * can be reused across many process generations; a generation key tracks the specific process.
 *
 * Consumers: the generation-aware turn interruption supervisor and foreground tool tracker compare
 * `generationKey` to detect mid-turn server replacement.
 */
export type OpenCodeManagedServerIdentity = Readonly<{
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  launchEnvFingerprint?: string;
  ownerToken?: string;
  startTimeMs?: number;
  activeServerDir?: string;
  daemonInstanceId?: string;
  logPath?: string;
  apiGeneration?: 'auto' | 'v2';
  generationKey: string;
}>;

export type OpenCodeManagedServerIdentityChangeReason =
  | 'initial'
  | 'state_refresh'
  | 'sse_reconnect_state_refresh'
  | 'http_retry_ensure'
  | 'health_recheck'
  | 'explicit_dispose';

export type OpenCodeManagedServerIdentityChange = Readonly<{
  previous: OpenCodeManagedServerIdentity | null;
  current: OpenCodeManagedServerIdentity | null;
  reason: OpenCodeManagedServerIdentityChangeReason;
}>;

function readNonEmptyString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Compute the stable generation key.
 *
 * Prefers `ownerToken` (rotated on every managed start) as the primary discriminator, and folds in
 * `pid`, `startedAtMs`, `startTimeMs`, `baseUrl`, and `launchEnvFingerprint` for robustness against
 * older state files that may lack an owner token. No secret/env values are included; the result is
 * a sha256 hex digest.
 */
function computeGenerationKey(identity: Omit<OpenCodeManagedServerIdentity, 'generationKey'>): string {
  const parts = [
    identity.ownerToken ? `owner=${identity.ownerToken}` : '',
    `pid=${identity.pid}`,
    `startedAtMs=${identity.startedAtMs}`,
    identity.startTimeMs ? `startTimeMs=${identity.startTimeMs}` : '',
    identity.launchEnvFingerprint ? `fp=${identity.launchEnvFingerprint}` : '',
    identity.apiGeneration ? `api=${identity.apiGeneration}` : '',
    identity.baseUrl ? `baseUrl=${identity.baseUrl}` : '',
  ].filter((part) => part.length > 0);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function resolveOpenCodeManagedServerIdentity(
  state: SharedManagedOpenCodeServerState,
): OpenCodeManagedServerIdentity {
  const launchEnvFingerprint = readNonEmptyString(state.launchEnvFingerprint);
  const ownerToken = readNonEmptyString(state.ownerToken);
  const activeServerDir = readNonEmptyString(state.activeServerDir);
  const daemonInstanceId = readNonEmptyString(state.daemonInstanceId);
  const logPath = readNonEmptyString(state.logPath);
  const apiGeneration = state.apiGeneration === 'auto' || state.apiGeneration === 'v2'
    ? state.apiGeneration
    : undefined;
  const startTimeMs = Number.isFinite(state.startTimeMs) && (state.startTimeMs ?? 0) > 0
    ? Math.floor(state.startTimeMs as number)
    : undefined;

  const partial: Omit<OpenCodeManagedServerIdentity, 'generationKey'> = {
    baseUrl: typeof state.baseUrl === 'string' ? state.baseUrl : '',
    pid: Number.isFinite(state.pid) ? state.pid : -1,
    startedAtMs: Number.isFinite(state.startedAtMs) ? state.startedAtMs : 0,
    ...(launchEnvFingerprint ? { launchEnvFingerprint } : {}),
    ...(ownerToken ? { ownerToken } : {}),
    ...(startTimeMs !== undefined ? { startTimeMs } : {}),
    ...(activeServerDir ? { activeServerDir } : {}),
    ...(daemonInstanceId ? { daemonInstanceId } : {}),
    ...(logPath ? { logPath } : {}),
    ...(apiGeneration ? { apiGeneration } : {}),
  };

  return {
    ...partial,
    generationKey: computeGenerationKey(partial),
  };
}

export function isSameOpenCodeManagedServerGeneration(
  a: OpenCodeManagedServerIdentity | null,
  b: OpenCodeManagedServerIdentity | null,
): boolean {
  if (!a || !b) return a === b;
  return a.generationKey === b.generationKey;
}

/**
 * Sanitized, log-safe summary. Never includes the raw owner token; the generation key (a hash) is
 * truncated for compact logs.
 */
export function describeOpenCodeManagedServerIdentityForLog(
  identity: OpenCodeManagedServerIdentity | null,
): Record<string, unknown> {
  if (!identity) return { present: false };
  return {
    generationKey: identity.generationKey.slice(0, 12),
    baseUrl: identity.baseUrl,
    pid: identity.pid,
    startedAtMs: identity.startedAtMs,
    ...(identity.startTimeMs ? { startTimeMs: identity.startTimeMs } : {}),
    ...(identity.launchEnvFingerprint ? { launchEnvFingerprint: identity.launchEnvFingerprint.slice(0, 12) } : {}),
    hasOwnerToken: Boolean(identity.ownerToken),
    ...(identity.activeServerDir ? { activeServerDir: identity.activeServerDir } : {}),
    ...(identity.daemonInstanceId ? { daemonInstanceId: identity.daemonInstanceId } : {}),
    ...(identity.logPath ? { logPath: identity.logPath } : {}),
    ...(identity.apiGeneration ? { apiGeneration: identity.apiGeneration } : {}),
  };
}
