import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HAPPIER_JOBS_SLICE_NAME, HAPPIER_SLICE_NAME, type SystemdUserSliceProbeFailure } from './systemdUserResourceGovernor';
import { sessionLaunchScopeUnitName, type SessionLaunchId } from './sessionLaunchId';

/**
 * What the launch path asked for. A scope name records intent only; whether the
 * runner is actually in that scope is decided by `observeSessionLaunchPlacement`.
 */
export type SessionLaunchPlacementIntent =
  | Readonly<{ kind: 'systemd-scope'; launchId: SessionLaunchId; unitName: string }>
  | Readonly<{ kind: 'unscoped'; probe: SystemdUserSliceProbeFailure }>;

export type SessionLaunchPlacementUnknownReason =
  | Readonly<{ kind: 'bound-elapsed' }>
  | Readonly<{ kind: 'pid-gone' }>
  | Readonly<{ kind: 'read-error'; message: string }>;

/**
 * The single placement outcome of one launch attempt.
 *
 * Placement is best-effort: an unscoped or unknown launch still runs, exactly as
 * before, and only this outcome says why it has no per-session handle.
 */
export type SessionLaunchPlacementOutcome =
  | Readonly<{ outcome: 'scoped'; unitName: string }>
  | Readonly<{ outcome: 'unscoped'; probe: SystemdUserSliceProbeFailure }>
  | Readonly<{ outcome: 'unknown'; lastCgroup: string | null; reason: SessionLaunchPlacementUnknownReason }>;

export const SESSION_LAUNCH_PLACEMENT_POLL_INTERVAL_MS = 50;
export const SESSION_LAUNCH_PLACEMENT_BOUND_MS = 2_000;

export function buildSessionLaunchPlacementIntent(launchId: SessionLaunchId): SessionLaunchPlacementIntent {
  return { kind: 'systemd-scope', launchId, unitName: sessionLaunchScopeUnitName(launchId) };
}

/** The cgroup path suffix a scoped runner of this attempt must be observed at. */
export function expectedSessionLaunchCgroupSuffix(params: Readonly<{ uid: number; unitName: string }>): string {
  return `/user@${params.uid}.service/${HAPPIER_SLICE_NAME}/${HAPPIER_JOBS_SLICE_NAME}/${params.unitName}`;
}

export type ReadProcFile = (path: string) => Promise<string>;

const defaultReadProcFile: ReadProcFile = async (path) => await readFile(path, 'utf8');

function parseUnifiedCgroupPath(raw: string): string | null {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('0::')) continue;
    const relativePath = line.slice('0::'.length).trim();
    return relativePath || null;
  }
  return null;
}

/** Field 22 of /proc/<pid>/stat (starttime). `comm` may contain spaces and parentheses. */
function parseProcessStartTime(rawStat: string): string | null {
  const commEnd = rawStat.lastIndexOf(')');
  if (commEnd < 0) return null;
  // Fields after `comm` start at field 3 (state); starttime is field 22.
  const fields = rawStat.slice(commEnd + 1).trim().split(/\s+/u);
  return fields[22 - 3] ?? null;
}

function isProcessGoneError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ESRCH';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-reads /proc/<pid>/cgroup until the runner is seen inside this attempt's scope, or
 * the bound elapses. A read counts only while the PID still names the same process: the
 * start time recorded at the first read must match, and `isKnownGone` (when the caller
 * owns the ChildProcess) must still be false.
 *
 * The bound is terminal and independent of the reads: a timer started with the
 * observation resolves `unknown` / `bound-elapsed` at the deadline even if a /proc read
 * never settles, and anything a read produces after that is ignored, so there is never
 * a late `scoped` or a second outcome. Both timers are unref'd and cleared on finish.
 *
 * systemd-run attaches its own PID to the scope and waits for the scope to start before
 * exec'ing the runner in that PID, so an observed path inside the scope proves the
 * attachment. It does not prove that exec succeeded.
 */
export async function observeSessionLaunchPlacement(params: Readonly<{
  pid: number;
  uid: number | null;
  unitName: string;
  procfsRootDir?: string;
  readProcFile?: ReadProcFile;
  isKnownGone?: () => boolean;
  pollIntervalMs?: number;
  boundMs?: number;
}>): Promise<SessionLaunchPlacementOutcome> {
  const procfsRootDir = params.procfsRootDir ?? '/proc';
  const readProcFile = params.readProcFile ?? defaultReadProcFile;
  const pollIntervalMs = params.pollIntervalMs ?? SESSION_LAUNCH_PLACEMENT_POLL_INTERVAL_MS;
  const boundMs = params.boundMs ?? SESSION_LAUNCH_PLACEMENT_BOUND_MS;
  const isKnownGone = params.isKnownGone ?? (() => false);

  let lastCgroup: string | null = null;
  const unknown = (reason: SessionLaunchPlacementUnknownReason): SessionLaunchPlacementOutcome => (
    { outcome: 'unknown', lastCgroup, reason }
  );
  if (params.uid === null) {
    return unknown({ kind: 'read-error', message: 'process uid unavailable' });
  }
  const expectedSuffix = expectedSessionLaunchCgroupSuffix({ uid: params.uid, unitName: params.unitName });
  const statPath = join(procfsRootDir, String(params.pid), 'stat');
  const cgroupPath = join(procfsRootDir, String(params.pid), 'cgroup');
  const readStartTime = async (): Promise<string | null> => parseProcessStartTime(await readProcFile(statPath));

  return await new Promise<SessionLaunchPlacementOutcome>((resolve) => {
    let finished = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const finish = (outcome: SessionLaunchPlacementOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      resolve(outcome);
    };
    const deadlineTimer = setTimeout(() => finish(unknown({ kind: 'bound-elapsed' })), boundMs);
    deadlineTimer.unref?.();
    // Resolves after the interval, or never once the observation has finished (its timer is cleared).
    const pause = async () => await new Promise<void>((wake) => {
      pollTimer = setTimeout(() => {
        pollTimer = null;
        wake();
      }, pollIntervalMs);
      pollTimer.unref?.();
    });

    // Returns null when the observation finished (deadline) while a read was in flight.
    const poll = async (): Promise<SessionLaunchPlacementOutcome | null> => {
      let identity: string | null;
      try {
        if (isKnownGone()) return unknown({ kind: 'pid-gone' });
        identity = await readStartTime();
      } catch (error) {
        if (finished) return null;
        return isProcessGoneError(error) ? unknown({ kind: 'pid-gone' }) : unknown({ kind: 'read-error', message: errorMessage(error) });
      }
      if (finished) return null;
      if (identity === null) {
        return unknown({ kind: 'read-error', message: `unparseable ${statPath}` });
      }

      for (;;) {
        try {
          const cgroup = parseUnifiedCgroupPath(await readProcFile(cgroupPath));
          if (finished) return null;
          // Discard the cgroup read unless the same process is still behind the PID afterwards.
          const startTimeAfter = await readStartTime();
          if (finished) return null;
          if (isKnownGone() || startTimeAfter !== identity) {
            return unknown({ kind: 'pid-gone' });
          }
          lastCgroup = cgroup;
          if (cgroup !== null && cgroup.endsWith(expectedSuffix)) {
            return { outcome: 'scoped', unitName: params.unitName };
          }
        } catch (error) {
          if (finished) return null;
          if (isProcessGoneError(error)) return unknown({ kind: 'pid-gone' });
          return unknown({ kind: 'read-error', message: errorMessage(error) });
        }
        await pause();
        if (finished) return null;
      }
    };

    poll().then(
      (outcome) => {
        if (outcome !== null) finish(outcome);
      },
      (error: unknown) => finish(unknown({ kind: 'read-error', message: errorMessage(error) })),
    );
  });
}

/** Resolves the placement outcome for an intent: observed for a scope, immediate otherwise. */
export async function resolveSessionLaunchPlacement(params: Readonly<{
  intent: SessionLaunchPlacementIntent;
  pid: number;
  uid: number | null;
  isKnownGone?: () => boolean;
  procfsRootDir?: string;
  readProcFile?: ReadProcFile;
}>): Promise<SessionLaunchPlacementOutcome> {
  if (params.intent.kind === 'unscoped') {
    return { outcome: 'unscoped', probe: params.intent.probe };
  }
  return await observeSessionLaunchPlacement({
    pid: params.pid,
    uid: params.uid,
    unitName: params.intent.unitName,
    isKnownGone: params.isKnownGone,
    procfsRootDir: params.procfsRootDir,
    readProcFile: params.readProcFile,
  });
}
