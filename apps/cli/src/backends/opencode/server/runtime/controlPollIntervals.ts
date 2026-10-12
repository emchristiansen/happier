export type OpenCodeServerControlPollIntervals = Readonly<{
  pollSleepMs: number;
  turnActivePollSleepMs: number;
}>;

type OpenCodeServerControlPollEnv = Readonly<Record<string, unknown>>;

function readEnvString(env: OpenCodeServerControlPollEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoundedPollIntervalMs(rawValue: string | undefined, defaultMs: number): number {
  const raw = Number.parseInt(String(rawValue ?? ''), 10);
  const configured = Number.isFinite(raw) && raw >= 25 ? Math.trunc(raw) : defaultMs;
  return Math.max(25, Math.min(2_000, configured));
}

export function resolveOpenCodeServerControlPollIntervals(
  env: OpenCodeServerControlPollEnv,
): OpenCodeServerControlPollIntervals {
  const pollSleepMs = readBoundedPollIntervalMs(
    readEnvString(env, 'HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS'),
    2_000,
  );
  const turnActivePollSleepMs = readBoundedPollIntervalMs(
    readEnvString(env, 'HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS'),
    pollSleepMs,
  );

  return { pollSleepMs, turnActivePollSleepMs };
}
