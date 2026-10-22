/**
 * The daemon's log-retention pass: trim old daemon logs, then sweep session logs. Only the
 * running daemon calls this (from its retention loop in startDaemon); see `logRetention.ts`.
 */

import { pruneLogsByCount, type PruneLogsByCountResult } from './pruneLogsByCount';
import { DAEMON_LOG_SUFFIX, resolveDaemonLogKeepCount, type EnvLike } from './logRetention';
import { sweepSessionLogs, type SweepSessionLogsResult } from './sweepSessionLogs';

export type DaemonLogRetentionParams = Readonly<{
  logsDir: string;
  /** The running daemon's own log: never deleted by either step. */
  currentLogPath: string;
  env?: EnvLike;
}>;

export type DaemonLogRetentionResult = Readonly<{
  daemonLogs: PruneLogsByCountResult;
  sessionLogs: SweepSessionLogsResult;
}>;

/** Keep the newest `HAPPIER_DAEMON_LOG_KEEP_COUNT` `*-daemon.log` files by name, plus the current one. Never throws. */
export async function trimDaemonLogs(params: DaemonLogRetentionParams): Promise<PruneLogsByCountResult> {
  return await pruneLogsByCount({
    dir: params.logsDir,
    suffix: DAEMON_LOG_SUFFIX,
    keepCount: resolveDaemonLogKeepCount(params.env ?? process.env),
    keepPath: params.currentLogPath,
  });
}

/**
 * Trim daemon logs, then sweep session logs. The session sweep's crash-evidence skip does not
 * apply to daemon logs, which have no crash evidence. Never throws.
 */
export async function runDaemonLogRetention(params: DaemonLogRetentionParams): Promise<DaemonLogRetentionResult> {
  const daemonLogs = await trimDaemonLogs(params);
  const sessionLogs = await sweepSessionLogs({
    logsDir: params.logsDir,
    protectedPaths: [params.currentLogPath],
    ...(params.env ? { env: params.env } : {}),
  });
  return { daemonLogs, sessionLogs };
}
