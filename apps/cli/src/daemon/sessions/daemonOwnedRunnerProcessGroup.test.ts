import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnedRunnerGroupTailCustody, readTrackedOwnedRunnerProcessGroupLeaderPid } from './daemonOwnedRunnerProcessGroup';
import { createOnChildExited } from './onChildExited';

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({ cleanupHookPluginDir: vi.fn() }));

const LEADER_PID = 930_001;

/** Simulated OS answer to the nondelivering group probe `kill(-LEADER_PID, 0)`; any other call fails the test. */
function simulateGroupProbe(answer: () => 'members' | 'ESRCH' | 'EPERM'): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== -LEADER_PID || signal !== 0) throw new Error(`unexpected signal ${String(signal)} to ${pid}`);
    const result = answer();
    if (result === 'members') return true;
    throw Object.assign(new Error(result), { code: result });
  }) as typeof process.kill);
}

const noWait = { timeoutMs: 0, pollIntervalMs: 1 } as const;

describe('OwnedRunnerGroupTailCustody', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps a tail while its group has members and discharges it only once the group is proven empty', async () => {
    let answer: 'members' | 'ESRCH' = 'members';
    simulateGroupProbe(() => answer);
    const custody = new OwnedRunnerGroupTailCustody();

    expect(custody.retainUnlessGroupEmpty({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID })).toBe(true);
    await expect(custody.reconcile('sess-1', noWait)).resolves.toMatchObject({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID });
    await expect(custody.reconcile('sess-other', noWait)).resolves.toBeNull();

    answer = 'ESRCH';
    await expect(custody.reconcile('sess-1', noWait)).resolves.toBeNull();
    // Discharged: a later observation, even a contradicting one, no longer refers to that tail.
    answer = 'members';
    await expect(custody.reconcile('sess-1', noWait)).resolves.toBeNull();
  });

  it('treats permission denial as unproven, never as an empty group', async () => {
    simulateGroupProbe(() => 'EPERM');
    const custody = new OwnedRunnerGroupTailCustody();

    expect(custody.retainUnlessGroupEmpty({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID })).toBe(true);
    await expect(custody.reconcile('sess-1', noWait)).resolves.not.toBeNull();
  });

  it('retains nothing for a group already proven empty', async () => {
    simulateGroupProbe(() => 'ESRCH');
    const custody = new OwnedRunnerGroupTailCustody();

    expect(custody.retainUnlessGroupEmpty({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID })).toBe(false);
    await expect(custody.reconcile('sess-1', noWait)).resolves.toBeNull();
  });

  it('waits a bounded time for members that finish shortly after the root', async () => {
    let probes = 0;
    simulateGroupProbe(() => (++probes < 3 ? 'members' : 'ESRCH'));
    const custody = new OwnedRunnerGroupTailCustody();
    custody.retainUnlessGroupEmpty({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID });

    await expect(custody.reconcile('sess-1', { timeoutMs: 1_000, pollIntervalMs: 1 })).resolves.toBeNull();
  });
});

describe('a session\'s unresolved owned runner group', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads a tracked daemon spawn\'s group whether or not its root still runs, and nothing for other records', () => {
    const exitedChild = { pid: LEADER_PID, exitCode: 0, signalCode: null };
    expect(readTrackedOwnedRunnerProcessGroupLeaderPid({ startedBy: 'daemon', pid: LEADER_PID, childProcess: exitedChild as any })).toBe(LEADER_PID);
    // Promoted, reattached and terminal-started records hold no handle that led the group.
    expect(readTrackedOwnedRunnerProcessGroupLeaderPid({ startedBy: 'daemon', pid: LEADER_PID, childProcess: undefined })).toBeNull();
    expect(readTrackedOwnedRunnerProcessGroupLeaderPid({ startedBy: 'daemon', pid: LEADER_PID, childProcess: { pid: 7 } as any })).toBeNull();
    expect(readTrackedOwnedRunnerProcessGroupLeaderPid({ startedBy: 'terminal' as any, pid: LEADER_PID, childProcess: exitedChild as any })).toBeNull();
  });

  it('holds a still-tracked group before any tail exists, and lets the session go once it is proven empty', async () => {
    let answer: 'members' | 'ESRCH' | 'EPERM' = 'members';
    simulateGroupProbe(() => answer);
    const custody = new OwnedRunnerGroupTailCustody();

    await expect(custody.reconcileSession('sess-1', [LEADER_PID], noWait))
      .resolves.toEqual({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID, holder: 'tracked_runner' });
    answer = 'EPERM';
    await expect(custody.reconcileSession('sess-1', [LEADER_PID], noWait)).resolves.not.toBeNull();
    answer = 'ESRCH';
    await expect(custody.reconcileSession('sess-1', [LEADER_PID], noWait)).resolves.toBeNull();
    await expect(custody.reconcileSession('sess-1', [], noWait)).resolves.toBeNull();
  });

  it('holds a retained tail once the record has retired', async () => {
    simulateGroupProbe(() => 'members');
    const custody = new OwnedRunnerGroupTailCustody();
    custody.retainUnlessGroupEmpty({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID });

    await expect(custody.reconcileSession(' sess-1 ', [], noWait))
      .resolves.toEqual({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID, holder: 'retained_tail' });
    await expect(custody.reconcileSession('sess-other', [], noWait)).resolves.toBeNull();
  });
});

describe('runner exit lifecycle and owned group tails', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function retireRoot(tracked: Record<string, unknown>, custody: OwnedRunnerGroupTailCustody) {
    const pidToTrackedSession = new Map<number, any>([[LEADER_PID, tracked]]);
    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: vi.fn(async () => undefined), // Filesystem boundary; exercise real exit staging.
      ownedRunnerGroupTails: custody,
    });
    await onChildExited(LEADER_PID, { reason: 'process-exited', code: 0, signal: 'SIGTERM' });
    // The root's tracking always retires: the tail is kept separately, not as an inert dead root.
    expect(pidToTrackedSession.has(LEADER_PID)).toBe(false);
  }
  const daemonOwnedRoot = () => ({
    pid: LEADER_PID, startedBy: 'daemon', happySessionId: 'sess-1',
    childProcess: { pid: LEADER_PID, exitCode: 0, signalCode: null },
  });

  it.runIf(process.platform !== 'win32')('retains the tail of a daemon-owned root that exits while its group has members', async () => {
    simulateGroupProbe(() => 'members');
    const custody = new OwnedRunnerGroupTailCustody();

    await retireRoot(daemonOwnedRoot(), custody);

    await expect(custody.reconcile('sess-1', noWait)).resolves.toMatchObject({ sessionId: 'sess-1', groupLeaderPid: LEADER_PID });
  });

  it.runIf(process.platform !== 'win32')('retains nothing when the daemon-owned group exits with its root', async () => {
    simulateGroupProbe(() => 'ESRCH');
    const custody = new OwnedRunnerGroupTailCustody();

    await retireRoot(daemonOwnedRoot(), custody);

    await expect(custody.reconcile('sess-1', noWait)).resolves.toBeNull();
  });

  it.each([
    ['a runner reattached from its marker', { pid: LEADER_PID, startedBy: 'daemon', happySessionId: 'sess-1', reattachedFromDiskMarker: true }],
    ['a terminal-started runner', { pid: LEADER_PID, startedBy: 'terminal', happySessionId: 'sess-1' }],
  ])('never claims or probes a group for %s', async (_label, tracked) => {
    simulateGroupProbe(() => 'members');
    const custody = new OwnedRunnerGroupTailCustody();

    await retireRoot(tracked, custody);

    expect(process.kill).not.toHaveBeenCalled();
    await expect(custody.reconcile('sess-1', noWait)).resolves.toBeNull();
  });
});
