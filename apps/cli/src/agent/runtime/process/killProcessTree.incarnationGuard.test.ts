import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.hoisted(() => vi.fn<() => Promise<Array<{ pid: number; ppid: number; name: string }>>>());
vi.mock('ps-list', () => ({ default: psListMock }));

import { killProcessTree, killProcessTreeGuarded, type ProcessTreeRootIdentity } from './killProcessTree';

const ROOT_PID = 910_001;
const CHILD_PID = 910_002;

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

/** Simulated `/proc/<ROOT_PID>/stat` reporting `pgrp` as the root's current process group id. */
function simulateRootProcessGroup(pgrp: number): void {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (path === `/proc/${ROOT_PID}/stat`) return `${ROOT_PID} (happier runner) S 1 ${pgrp} ${pgrp} 0 -1\n`;
    return (readFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(path, options);
  }) as typeof fs.readFileSync);
}

const groupSignals = (calls: readonly SignalCall[]) => calls.filter(([pid]) => pid === -ROOT_PID).map(([, signal]) => signal);
const rootSignals = (calls: readonly SignalCall[]) => calls.filter(([pid]) => pid === ROOT_PID).map(([, signal]) => signal);
const childSignals = (calls: readonly SignalCall[]) => calls.filter(([pid]) => pid === CHILD_PID).map(([, signal]) => signal);

describe('killProcessTree root identity guard', () => {
  afterEach(() => {
    psListMock.mockReset();
    vi.restoreAllMocks();
  });

  it('keeps unguarded signals children-first and reports the root observation', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTree({ pid: ROOT_PID }, { graceMs: 1 })).resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });

    expect(calls).toEqual([
      [CHILD_PID, 'SIGTERM'],
      [ROOT_PID, 'SIGTERM'],
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
  });

  it('repeats discovery until a fresh snapshot finds no new descendant', async () => {
    if (process.platform === 'win32') return;
    const LATE_PID = 910_003;
    // The second snapshot shows a child the first one had not yet listed.
    psListMock
      .mockResolvedValueOnce([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }])
      .mockResolvedValue([
        { pid: CHILD_PID, ppid: ROOT_PID, name: 'child' },
        { pid: LATE_PID, ppid: ROOT_PID, name: 'late' },
      ]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID, LATE_PID]) });

    await killProcessTree({ pid: ROOT_PID }, { graceMs: 1 });

    expect(calls.filter(([pid]) => pid === LATE_PID).map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(calls.findIndex(([pid]) => pid === LATE_PID)).toBeLessThan(calls.findIndex(([pid]) => pid === ROOT_PID));
    expect(psListMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['unguarded success', () => killProcessTree({ pid: ROOT_PID }, { graceMs: 1 })],
    ['guarded success', () => killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, readRootIdentity: () => 'same' })],
    ['declared group', () => killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity: () => 'same' })],
    ['unreadable root', () => killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, readRootIdentity: () => 'unreadable' })],
  ] as const)('never requests a suspension signal (%s)', async (_name, run) => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await run();

    for (const [, signal] of calls) expect(['SIGSTOP', 'SIGTSTP', 'SIGCONT']).not.toContain(signal);
  });

  it('still kills a surviving child when the root exits normally during the grace wait', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const alive = new Set([ROOT_PID, CHILD_PID]);
    // The root exits on SIGTERM; the child ignores SIGTERM.
    const { calls } = simulateProcesses({
      alive,
      onSignal: (pid, signal) => { if (pid === -ROOT_PID && signal === 'SIGTERM') alive.delete(ROOT_PID); },
    });
    const readRootIdentity = (): ProcessTreeRootIdentity => (alive.has(ROOT_PID) ? 'same' : 'not_same');

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity }))
      .resolves.toBe('completed');

    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(groupSignals(calls)).toEqual(['SIGTERM']);
  });

  it('refuses a guarded root with no declared owned group before discovering or signalling anything', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, readRootIdentity: () => 'same' }))
      .resolves.toBe('snapshot_only');

    expect(calls).toEqual([]);
    expect(psListMock).not.toHaveBeenCalled();
  });

  it('completes through the declared owned process group while the root is the same process', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const alive = new Set([ROOT_PID, CHILD_PID]);
    const { calls } = simulateProcesses({
      alive,
      onSignal: (pid, signal) => { if (pid === -ROOT_PID && signal === 'SIGTERM') alive.delete(ROOT_PID); },
    });
    const readRootIdentity = (): ProcessTreeRootIdentity => (alive.has(ROOT_PID) ? 'same' : 'not_same');

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity }))
      .resolves.toBe('completed');

    expect(groupSignals(calls)).toEqual(['SIGTERM']);
    expect(rootSignals(calls)).toEqual([]);
    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports group coverage to an unguarded owner of the spawned group-leader ChildProcess', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID]) });
    const ownedChild = { pid: ROOT_PID, exitCode: null, signalCode: null };

    await expect(killProcessTree(ownedChild, { graceMs: 1, processGroup: 'owned' }))
      .resolves.toEqual({ rootObservedAlive: true, coverage: 'process_group' });
    expect(groupSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(rootSignals(calls)).toEqual([]);
  });

  it('never signals a group for a bare pid, even when declared, and reports snapshot coverage', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID]) });

    // A bare pid carries no exit record, so nothing validates that the group is still this root's.
    await expect(killProcessTree({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned' }))
      .resolves.toEqual({ rootObservedAlive: true, coverage: 'snapshot' });
    expect(groupSignals(calls)).toEqual([]);
    expect(rootSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not promote an undeclared root that happens to lead its own group', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, readRootIdentity: () => 'same' }))
      .resolves.toBe('snapshot_only');
    expect(calls).toEqual([]);
  });

  it('refuses the group signal when the OS reports the declared root in another group', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID + 7);
    psListMock.mockResolvedValue([]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity: () => 'same' }))
      .resolves.toBe('snapshot_only');
    // Neither the group the OS names, nor the root PID alone: a guarded owner signals nothing.
    expect(calls).toEqual([]);
  });

  it('refuses every group signal when the declared root becomes unreadable', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });
    const readRootIdentity = (): ProcessTreeRootIdentity => (psListMock.mock.calls.length > 0 ? 'unreadable' : 'same');

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity }))
      .resolves.toBe('root_unreadable');
    expect(calls).toEqual([]);
  });

  it('sends no group SIGKILL once the declared root pid is reused', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    let rootReused = false;
    const { calls } = simulateProcesses({
      alive: new Set([ROOT_PID, CHILD_PID]),
      onSignal: (pid, signal) => { if (pid === -ROOT_PID && signal === 'SIGTERM') rootReused = true; },
    });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      processGroup: 'owned',
      readRootIdentity: () => (rootReused ? 'not_same' : 'same'),
    })).resolves.toBe('root_not_same');
    expect(groupSignals(calls)).toEqual(['SIGTERM']);
    expect(rootSignals(calls)).toEqual([]);
    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('sends a root it cannot re-identify after discovery nothing, and signals none of its snapshot', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });
    const readRootIdentity = vi.fn((): ProcessTreeRootIdentity => (psListMock.mock.calls.length > 0 ? 'unreadable' : 'same'));

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, { graceMs: 1, processGroup: 'owned', readRootIdentity }))
      .resolves.toBe('root_unreadable');

    expect(calls).toEqual([]);
  });

  it('sends no root SIGKILL after pid reuse, still handles descendants, and reports root_not_same', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    let rootReused = false;
    // The root exits on SIGTERM and its pid is immediately reused by a live, unrelated process.
    const { calls } = simulateProcesses({
      alive: new Set([ROOT_PID, CHILD_PID]),
      onSignal: (pid, signal) => { if (pid === -ROOT_PID && signal === 'SIGTERM') rootReused = true; },
    });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      processGroup: 'owned',
      readRootIdentity: () => (rootReused ? 'not_same' : 'same'),
    })).resolves.toBe('root_not_same');

    expect(groupSignals(calls)).toEqual(['SIGTERM']);
    expect(rootSignals(calls)).toEqual([]);
    expect(childSignals(calls)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('signals no enumerated child when the root is replaced during enumeration', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
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
      processGroup: 'owned',
      readRootIdentity: () => (rootReplaced ? 'not_same' : 'same'),
    })).resolves.toBe('root_not_same');

    expect(calls).toEqual([]);
  });

  it('signals nothing when the root is already another process', async () => {
    if (process.platform === 'win32') return;
    psListMock.mockResolvedValue([{ pid: CHILD_PID, ppid: ROOT_PID, name: 'child' }]);
    const { calls } = simulateProcesses({ alive: new Set([ROOT_PID, CHILD_PID]) });

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1, readRootIdentity: () => 'not_same',
    })).resolves.toBe('root_not_same');

    expect(calls).toEqual([]);
    expect(psListMock).not.toHaveBeenCalled();
  });

  it('evaluates the guard immediately before every root signal', async () => {
    if (process.platform !== 'linux') return;
    simulateRootProcessGroup(ROOT_PID);
    psListMock.mockResolvedValue([]);
    const order: string[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) order.push(`${pid}:${String(signal)}`);
      return true;
    }) as typeof process.kill);

    await expect(killProcessTreeGuarded({ pid: ROOT_PID }, {
      graceMs: 1,
      processGroup: 'owned',
      readRootIdentity: () => { order.push('guard'); return 'same'; },
    })).resolves.toBe('completed');

    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const index = order.indexOf(`${-ROOT_PID}:${signal}`);
      expect(index, signal).toBeGreaterThan(0);
      expect(order[index - 1], signal).toBe('guard');
    }
  });
});
