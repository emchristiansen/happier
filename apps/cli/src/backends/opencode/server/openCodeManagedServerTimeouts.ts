const DEFAULT_MANAGED_SERVER_START_TIMEOUT_MS = 120_000;
const MAX_MANAGED_SERVER_TIMEOUT_MS = 1_800_000;
const LOCK_COMPLETION_MARGIN_MS = 5_000;

function readPositiveTimeoutMs(raw: unknown, fallbackMs: number): number {
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.min(Math.floor(parsed), MAX_MANAGED_SERVER_TIMEOUT_MS);
}

export function resolveOpenCodeManagedServerStartTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  return readPositiveTimeoutMs(
    env.HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS,
    DEFAULT_MANAGED_SERVER_START_TIMEOUT_MS,
  );
}

export function resolveOpenCodeManagedServerLockTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const startTimeoutMs = resolveOpenCodeManagedServerStartTimeoutMsFromEnv(env);
  return readPositiveTimeoutMs(
    env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS,
    Math.min(startTimeoutMs + LOCK_COMPLETION_MARGIN_MS, MAX_MANAGED_SERVER_TIMEOUT_MS),
  );
}
