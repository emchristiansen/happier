import { afterEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.hoisted(() => vi.fn<() => Promise<Array<{ pid: number; ppid: number; name: string }>>>());
vi.mock('ps-list', () => ({ default: psListMock }));

import { killProcessTree } from './killProcessTree';

const ROOT_PID = 910_001;
const CHILD_PID = 910_002;

type SignalCall = readonly [pid: number, signal: NodeJS.Signals | number | undefined];

/** Records every non-probe signal; signal 0 (liveness) always reports alive, so escalation is reached. */
function spyOnSignals(): { calls: SignalCall[]; restore: () => void } {
  const calls: SignalCall[] = [];
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== 0) calls.push([pid, signal]);
    return true;
  }) as typeof process.kill);
  return { calls, restore: () => spy.mockRestore() };
}

describe('killProcessTree root incarnation guard', () => {
  afterEach(() => {
    psListMock.mockReset();
    vi.restoreAllMocks();
  });

  it('still escalates to SIGKILL without a guard (ordinary cleanup unchanged)', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const signals = spyOnSignals();

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1 });
    signals.restore();

    expect(signals.calls).toEqual(expect.arrayContaining([
      [ROOT_PID, 'SIGSTOP'],
      [CHILD_PID, 'SIGTERM'],
      [ROOT_PID, 'SIGCONT'],
      [ROOT_PID, 'SIGTERM'],
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]));
  });

  it('sends no SIGKILL when the root incarnation changes between SIGTERM and the escalation decision', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const signals = spyOnSignals();
    let rootReplaced = false;
    const isRootIncarnation = vi.fn(() => !rootReplaced);
    // The root exits on SIGTERM and its pid is reused by another process before escalation.
    vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) signals.calls.push([pid, signal]);
      if (pid === ROOT_PID && signal === 'SIGTERM') rootReplaced = true;
      return true;
    }) as typeof process.kill);

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1, isRootIncarnation });
    signals.restore();

    expect(signals.calls).toEqual([
      [ROOT_PID, 'SIGSTOP'],
      [CHILD_PID, 'SIGTERM'],
      [ROOT_PID, 'SIGCONT'],
      [ROOT_PID, 'SIGTERM'],
    ]);
    expect(isRootIncarnation).toHaveBeenCalled();
  });

  it('evaluates the guard immediately before every root signal', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([]);
    const order: string[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) order.push(`${pid}:${String(signal)}`);
      return true;
    }) as typeof process.kill);
    const isRootIncarnation = vi.fn(() => {
      order.push('guard');
      return true;
    });

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1, isRootIncarnation });

    for (const signal of ['SIGSTOP', 'SIGCONT', 'SIGTERM', 'SIGKILL']) {
      const index = order.indexOf(`${ROOT_PID}:${signal}`);
      expect(index, signal).toBeGreaterThan(0);
      expect(order[index - 1], signal).toBe('guard');
    }
  });

  it('signals nothing at all when the root is already another incarnation', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const signals = spyOnSignals();

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1, isRootIncarnation: () => false });
    signals.restore();

    expect(signals.calls).toEqual([]);
  });

  it('sends descendants nothing once the root guard fails during enumeration', async () => {
    if (process.platform === 'win32') return;
    let rootReplaced = false;
    psListMock.mockImplementation(async () => {
      rootReplaced = true;
      return [{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }];
    });
    const signals = spyOnSignals();

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1, isRootIncarnation: () => !rootReplaced });
    signals.restore();

    expect(signals.calls).toEqual([[ROOT_PID, 'SIGSTOP']]);
  });
});
