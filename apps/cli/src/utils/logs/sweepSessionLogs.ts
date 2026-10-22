/**
 * The daemon's session-log retention sweep. The policy and its knobs live in `logRetention.ts`;
 * this module applies it to one logs directory, best effort: any fs error skips that file.
 */

import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  DAEMON_LOG_SUFFIX,
  LOG_FILE_SUFFIX,
  resolveCrashedSessionLogKeepCount,
  resolveSessionLogKeepCount,
  resolveSessionLogMinAgeMs,
  type EnvLike,
} from './logRetention';

export type SweepSessionLogsParams = Readonly<{
  logsDir: string;
  /** Never deleted, whatever the policy says (the daemon passes its own current log). */
  protectedPaths?: readonly string[];
  env?: EnvLike;
}>;

export type SweepSessionLogsResult = Readonly<{
  deleted: number;
}>;

type CrashedSessionExitReportReference = Readonly<{
  pid: number;
  observedAt: number;
}>;

export function isSessionLogFileName(name: string): boolean {
  return name.endsWith(LOG_FILE_SUFFIX) && !name.endsWith(DAEMON_LOG_SUFFIX);
}

/** The writer's pid from a `...-pid-<n>.log` name, or null when the name carries none. */
export function parseSessionLogPid(name: string): number | null {
  const match = /-pid-(\d+)\.log$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

/** (a) A log whose writer still runs is in use. A name without a pid has no live writer. */
function isWrittenByLiveProcess(name: string): boolean {
  const pid = parseSessionLogPid(name);
  return pid !== null && isProcessAlive(pid);
}

/** (b) Only logs untouched for longer than the minimum retention age may go. */
function isOlderThanMinimumAge(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

/** (c) Names are `<local timestamp>-pid-<n>.log`, so name order is creation order. */
function selectNewestSessionLogNames(names: readonly string[], keepCount: number): ReadonlySet<string> {
  return new Set([...names].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, keepCount));
}

async function readCrashedSessionExitReport(path: string): Promise<CrashedSessionExitReportReference | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { pid?: unknown; code?: unknown; signal?: unknown; observedAt?: unknown };
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
    if (pid === null) return null;
    const crashed = (typeof record.code === 'number' && record.code !== 0)
      || (typeof record.signal === 'string' && record.signal.trim().length > 0);
    if (!crashed) return null;
    const observedAt = typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
      ? Math.trunc(record.observedAt)
      : Math.trunc((await lstat(path)).mtimeMs);
    return { pid, observedAt };
  } catch {
    return null;
  }
}

/** (d) Logs of the newest `keepCount` crashed runners (non-zero exit or signal in `session-exit/`). */
async function selectKeptCrashedSessionLogNames(
  logsDir: string,
  names: readonly string[],
  keepCount: number,
): Promise<ReadonlySet<string>> {
  if (keepCount <= 0) return new Set();
  const sessionExitDir = join(logsDir, 'session-exit');
  let reportFiles: string[];
  try {
    reportFiles = (await readdir(sessionExitDir)).filter((file) => file.endsWith('.json'));
  } catch {
    return new Set();
  }
  const reports = await Promise.all(reportFiles.map((file) => readCrashedSessionExitReport(join(sessionExitDir, file))));
  const keptCrashedPids = new Set(
    reports
      .filter((report): report is CrashedSessionExitReportReference => report !== null)
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, keepCount)
      .map((report) => report.pid),
  );
  return new Set(names.filter((name) => {
    const pid = parseSessionLogPid(name);
    return pid !== null && keptCrashedPids.has(pid);
  }));
}

async function readMtimeMs(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Delete each session log in `logsDir` that is (a) not written by a live process, (b) older than
 * the minimum retention age, (c) not among the newest session logs by name and (d) not a kept
 * crashed-runner log. Never throws.
 */
export async function sweepSessionLogs(params: SweepSessionLogsParams): Promise<SweepSessionLogsResult> {
  const env = params.env ?? process.env;
  let names: string[];
  try {
    names = (await readdir(params.logsDir)).filter(isSessionLogFileName);
  } catch {
    return { deleted: 0 };
  }

  const protectedPaths = new Set((params.protectedPaths ?? []).map((path) => resolve(path)));
  const newest = selectNewestSessionLogNames(names, resolveSessionLogKeepCount(env));
  const crashed = await selectKeptCrashedSessionLogNames(params.logsDir, names, resolveCrashedSessionLogKeepCount(env));
  const minAgeMs = resolveSessionLogMinAgeMs(env);
  const nowMs = Date.now();

  let deleted = 0;
  for (const name of names) {
    const path = join(params.logsDir, name);
    if (protectedPaths.has(resolve(path))) continue;
    if (newest.has(name) || crashed.has(name)) continue;
    if (isWrittenByLiveProcess(name)) continue;
    const mtimeMs = await readMtimeMs(path);
    if (mtimeMs === null || !isOlderThanMinimumAge(mtimeMs, nowMs, minAgeMs)) continue;
    try {
      await rm(path);
      deleted += 1;
    } catch {
      // Best effort: a file that cannot be removed stays for the next sweep.
    }
  }
  return { deleted };
}
