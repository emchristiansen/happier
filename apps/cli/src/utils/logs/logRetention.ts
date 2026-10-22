/**
 * Centralized log-retention policy for ~/.happier/logs.
 *
 * Only the running daemon prunes: the process executing startDaemon(), i.e. `daemon start-sync`
 * after it decides to start, not a process whose argv merely names the daemon (help, the detached
 * `daemon start` launcher). No other CLI process deletes anything in the logs dir. The daemon runs
 * one retention pass at startup and every {@link LOG_RETENTION_INTERVAL_MS} (see
 * `daemonLogRetention.ts`):
 *
 * - Daemon logs (`*-daemon.log`): keep the newest {@link DEFAULT_DAEMON_LOG_KEEP_COUNT} by name,
 *   plus the running daemon's own log. A daemon log is created once per daemon start, so
 *   repeating this hourly removes nothing the startup pass would not.
 * - Session logs (all other `*.log`), by age plus count (see `sweepSessionLogs.ts`). A session
 *   log is deleted only when ALL of these hold:
 *   a. its writer pid (from `-pid-<n>.log`) is known and dead; a name without a pid is kept;
 *   b. it was last modified more than {@link DEFAULT_SESSION_LOG_MIN_AGE_DAYS} days ago;
 *   c. it is not among the newest {@link DEFAULT_SESSION_LOG_KEEP_COUNT} session logs by name;
 *   d. it is not the log of one of the newest {@link DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT}
 *      crashed runners (non-zero exit code or a signal in `session-exit/*.json`).
 *   When (d) cannot be established because crash reports cannot be read, the sweep deletes
 *   nothing that pass.
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
export const LOG_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

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
