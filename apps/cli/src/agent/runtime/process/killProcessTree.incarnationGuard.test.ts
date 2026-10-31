import { afterEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.hoisted(() => vi.fn<() => Promise<Array<{ pid: number; ppid: number; name: string }>>>());
vi.mock('ps-list', () => ({ default: psListMock }));

import { killProcessTree, killProcessTreeGuarded, type ProcessTreeRootIdentity } from './killProcessTree';

const ROOT_PID = 910_001;
const CHILD_PID = 910_002;
const NO_RETRY_WAIT = [1, 1, 1] as const;

type SignalCall = readonly [pid: number, signal: NodeJS.Signals | number | undefined];

/**
 * Simulated OS boundary: records every non-probe signal, answers liveness (signal 0) from `alive`,
 * and lets each test react to a signal (a root exiting on SIGTERM, a pid being reused, ...).
 */
function simulateProcesses(params: Readonly<{
  alive: Set<number>;
  onSignal?: (pid: number, signal: NodeJS.Signals | number | undefined) => void;
}>): { calls: SignalCall[] } {
  const calls: SignalCall[] = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) {
      if (!params.alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }
    calls.push([pid, signal]);
    params.onSignal?.(pid, signal);
    return true;
  }) as typeof process.kill);
  return { calls };
}

const rootSignals = (calls: readonly SignalCall[]) => calls.filter(([pid]) => pid === ROOT_PID).map(([, signal]) => signal);
const childSignals = (calls: readonly SignalCall[]) => calls.filter(([pid]) => pid === CHILD_PID).map(([, signal]) => signal);

describe('killProcessTree root identity guard', () => {
  afterEach(() => {
    psListMock.mockReset();
    vi.restoreAllMocks();
  });

  it('keeps unguarded signals and reports the upstream root observation', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTree({ pid: ROOT_PID }, { graceMs: 1 })).resolves.toEqual({ rootObservedAlive: true });

    expect(calls).toEqual([
      [ROOT_PID, 'SIGSTOP'],
      [CHILD_PID, 'SIGTERM'],
      [ROOT_PID, 'SIGCONT'],
      [ROOT_PID, 'SIGTERM'],
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
  });

  it('still kills a surviving child when the root exits normally during the grace wait', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const alive = new Set([ROOT_PID, CHILD_PID]);
    // The root exits on SIGTERM; the child ignores SIGTERM.
    const { calls } = simulateProcesses({
      alive,
      onSignal: (pid, signal) => { if (pid === ROOT_PID && signal === 'SIGTERM') alive.delete(ROOT_PID); },
    });
    const readRootIdentity = (): ProcessTreeRootIdentity => (alive.has(ROOT_PID) ? 'same' : 'not_same');

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1, readRootIdentity, unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('completed');

    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(rootSignals(calls)).toEqual(['SIGSTOP', 'SIGCONT', 'SIGTERM']);
  });

  it('completes normally when an unreadable identity after SIGSTOP recovers on retry', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });
    let unreadableReadsLeft = 2;
    const readRootIdentity = vi.fn((): ProcessTreeRootIdentity => {
      if (rootSignals(calls).includes('SIGSTOP') && unreadableReadsLeft > 0) {
        unreadableReadsLeft -= 1;
        return 'unreadable';
      }
      return 'same';
    });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1, readRootIdentity, unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('completed');

    expect(rootSignals(calls)).toEqual(['SIGSTOP', 'SIGCONT', 'SIGTERM', 'SIGKILL']);
    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('leaves a root it cannot re-identify suspended, sends it nothing more, and reports that', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });
    const readRootIdentity = vi.fn((): ProcessTreeRootIdentity => (rootSignals(calls).includes('SIGSTOP') ? 'unreadable' : 'same'));

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1, readRootIdentity, unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('root_unreadable_suspended');

    expect(rootSignals(calls)).toEqual(['SIGSTOP']);
    // The root could not be verified after the snapshot, so the snapshot's children are not signalled.
    expect(childSignals(calls)).toEqual([]);
    // The bounded retry ran before settling: the pre-SIGSTOP read, then the post-snapshot read and its retries.
    expect(readRootIdentity.mock.calls.length).toBe(1 + 1 + NO_RETRY_WAIT.length);
  });

  it('sends no root SIGKILL after pid reuse, still handles descendants, and reports root_not_same', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    let rootReused = false;
    // The root exits on SIGTERM and its pid is immediately reused by a live, unrelated process.
    const { calls } = simulateProcesses({
      alive: new Set([ROOT_PID, CHILD_PID]),
      onSignal: (pid, signal) => { if (pid === ROOT_PID && signal === 'SIGTERM') rootReused = true; },
    });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      readRootIdentity: () => (rootReused ? 'not_same' : 'same'),
      unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('root_not_same');

    expect(rootSignals(calls)).toEqual(['SIGSTOP', 'SIGCONT', 'SIGTERM']);
    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('signals no enumerated child when the root is replaced during enumeration', async () => {
    if (process.platform === 'win32') return;
    let rootReplaced = false;
    // The root is killed externally and its pid reused while the snapshot is taken; the listed child
    // belongs to the unrelated process now holding ROOT_PID.
    psListMock.mockImplementation(async () => {
      rootReplaced = true;
      return [{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }];
    });
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      readRootIdentity: () => (rootReplaced ? 'not_same' : 'same'),
      unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('root_not_same');

    expect(rootSignals(calls)).toEqual(['SIGSTOP']);
    expect(childSignals(calls)).toEqual([]);
  });

  it('signals no enumerated child when the root turns unreadable between the snapshot and its check', async () => {
    if (process.platform === 'win32') return;
    let rootUnreadable = false;
    psListMock.mockImplementation(async () => {
      rootUnreadable = true;
      return [{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }];
    });
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      readRootIdentity: () => (rootUnreadable ? 'unreadable' : 'same'),
      unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('root_unreadable_suspended');

    expect(rootSignals(calls)).toEqual(['SIGSTOP']);
    expect(childSignals(calls)).toEqual([]);
  });

  it('signals nothing when the root is already another process', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1, readRootIdentity: () => 'not_same', unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('root_not_same');

    expect(calls).toEqual([]);
    expect(psListMock).not.toHaveBeenCalled();
  });

  it('evaluates the guard immediately before every root signal', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([]);
    const order: string[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) order.push(`${pid}:${String(signal)}`);
      return true;
    }) as typeof process.kill);

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      readRootIdentity: () => { order.push('guard'); return 'same'; },
      unreadableRetryDelaysMs: NO_RETRY_WAIT,
    })).resolves.toBe('completed');

    for (const signal of ['SIGSTOP', 'SIGCONT', 'SIGTERM', 'SIGKILL']) {
      const index = order.indexOf(`${ROOT_PID}:${signal}`);
      expect(index, signal).toBeGreaterThan(0);
      expect(order[index - 1], signal).toBe('guard');
    }
  });
});
