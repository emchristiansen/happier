/**
 * Centralized log-retention policy for ~/.happier/logs.
 *
 * Only the daemon prunes; session logs by age plus count. No other CLI process (session
 * runner, `session send`, `--help`, status, ...) deletes anything in the logs dir.
 *
 * - Daemon logs (`*-daemon.log`): each daemon process, when its logger starts, keeps the newest
 *   {@link DEFAULT_DAEMON_LOG_KEEP_COUNT} by name.
 * - Session logs (all other `*.log`): the daemon sweeps them at startup and every
 *   {@link SESSION_LOG_SWEEP_INTERVAL_MS} (see `sweepSessionLogs.ts`). A session log is deleted
 *   only when ALL of these hold:
 *   a. its writer pid (from `-pid-<n>.log`) is not alive (a name without a pid skips this test);
 *   b. it was last modified more than {@link DEFAULT_SESSION_LOG_MIN_AGE_DAYS} days ago;
 *   c. it is not among the newest {@link DEFAULT_SESSION_LOG_KEEP_COUNT} session logs by name;
 *   d. it is not the log of one of the newest {@link DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT}
 *      crashed runners (non-zero exit code or a signal in `session-exit/*.json`).
 *
 * Every budget is env-overridable (`HAPPIER_DAEMON_LOG_KEEP_COUNT`,
 * `HAPPIER_SESSION_LOG_KEEP_COUNT`, `HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT`,
 * `HAPPIER_SESSION_LOG_MIN_AGE_DAYS`) for support/debugging scenarios; a blank, non-finite or
 * negative value falls back to the default.
 */

export const DAEMON_LOG_SUFFIX = '-daemon.log';
export const LOG_FILE_SUFFIX = '.log';

export const DEFAULT_DAEMON_LOG_KEEP_COUNT = 50;
export const DEFAULT_SESSION_LOG_KEEP_COUNT = 200;
export const DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT = 20;
export const DEFAULT_SESSION_LOG_MIN_AGE_DAYS = 14;
export const SESSION_LOG_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EnvLike = Readonly<Record<string, string | undefined>>;

function resolveNonNegativeNumber(rawValue: string | undefined, fallback: number): number {
  // `Number('')` is 0, so a blank variable would silently mean "keep nothing"; treat it as unset.
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveKeepCount(rawValue: string | undefined, fallback: number): number {
  return Math.floor(resolveNonNegativeNumber(rawValue, fallback));
}

export function resolveDaemonLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_DAEMON_LOG_KEEP_COUNT, DEFAULT_DAEMON_LOG_KEEP_COUNT);
}

export function resolveSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_SESSION_LOG_KEEP_COUNT, DEFAULT_SESSION_LOG_KEEP_COUNT);
}

export function resolveCrashedSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT, DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT);
}

export function resolveSessionLogMinAgeMs(env: EnvLike = process.env): number {
  return resolveNonNegativeNumber(env.HAPPIER_SESSION_LOG_MIN_AGE_DAYS, DEFAULT_SESSION_LOG_MIN_AGE_DAYS) * DAY_MS;
}
