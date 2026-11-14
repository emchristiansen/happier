import type { PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';

type TrackedLauncherLike = Readonly<{
  pid?: number;
  sessionRunnerPid?: number;
  processInstanceFingerprint?: string;
}>;

/**
 * The launcher process the daemon tracks (`pid`): the identity spawn custody records on its decisions.
 * When a wrapper's child reported as the session runner, `processInstanceFingerprint` is that
 * reporter's, not the launcher's, so it is never paired with the launcher pid (HPI-31).
 */
export function readTrackedLauncherIdentity(tracked: TrackedLauncherLike): PerSessionAssignmentRunner | null {
  if (typeof tracked.pid !== 'number' || tracked.pid <= 0) return null;
  const reporterIsDistinct = typeof tracked.sessionRunnerPid === 'number' && tracked.sessionRunnerPid !== tracked.pid;
  return {
    pid: tracked.pid,
    ...(tracked.processInstanceFingerprint && !reporterIsDistinct ? { processInstanceFingerprint: tracked.processInstanceFingerprint } : {}),
  };
}
