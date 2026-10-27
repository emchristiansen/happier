import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  observeSessionLaunchPlacement,
  resolveSessionLaunchPlacement,
  type ReadProcFile,
} from './observeSessionLaunchPlacement';
import type { SessionLaunchId } from './sessionLaunchId';

const LAUNCH_ID = '3c2b1a09-8f7e-4d6c-9b5a-493827160504' as SessionLaunchId;
const UNIT = `happier-launch-${LAUNCH_ID}.scope`;
const SCOPED_CGROUP = `/user.slice/user-1000.slice/user@1000.service/happier.slice/happier-jobs.slice/${UNIT}`;
const DAEMON_CGROUP = '/system.slice/happier-daemon.service';

function stat(pid: number, startTime: string): string {
  // `comm` with spaces and a parenthesis must not shift the fields.
  const fieldsAfterComm = ['S', '1', String(pid), String(pid), '0', '-1', '4194560', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', startTime, '0'];
  return `${pid} (node (runner) x) ${fieldsAfterComm.join(' ')}\n`;
}

type ProcState = { cgroup: string; startTime: string } | 'gone' | Error;

/**
 * A fake /proc. `states[0]` answers the observer's first (identity) stat read; each later
 * state answers one poll, a cgroup read followed by its identity re-check.
 */
function fakeProc(pid: number, states: readonly ProcState[]): { readProcFile: ReadProcFile; cgroupReads: () => number } {
  let step = 0;
  let cgroupReads = 0;
  const current = () => states[Math.min(step, states.length - 1)]!;
  const readProcFile: ReadProcFile = async (path) => {
    const state = current();
    if (state === 'gone') throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    if (state instanceof Error) throw state;
    if (path === `/proc/${pid}/stat`) {
      step += 1;
      return stat(pid, state.startTime);
    }
    if (path === `/proc/${pid}/cgroup`) {
      cgroupReads += 1;
      return `0::${state.cgroup}\n`;
    }
    throw new Error(`unexpected read ${path}`);
  };
  return { readProcFile, cgroupReads: () => cgroupReads };
}

type Observation = { outcome: Awaited<ReturnType<typeof observeSessionLaunchPlacement>> | null };

/** Starts an observation and records its outcome without awaiting it, so a hang cannot hang the test. */
function start(params: Parameters<typeof observeSessionLaunchPlacement>[0]): Observation {
  const observation: Observation = { outcome: null };
  void observeSessionLaunchPlacement(params).then((outcome) => { observation.outcome = outcome; });
  return observation;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('observeSessionLaunchPlacement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports scoped once the same process is seen inside this attempt\'s scope', async () => {
    const proc = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: SCOPED_CGROUP, startTime: '777' },
    ]);
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile });

    await vi.advanceTimersByTimeAsync(99);
    expect(observation.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(observation.outcome).toEqual({ outcome: 'scoped', unitName: UNIT });
    expect(proc.cgroupReads()).toBe(3);
    // Neither the poll timer nor the deadline timer outlives the observation.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reports scoped for another attempt\'s scope; it reports unknown when the bound elapses', async () => {
    const otherScope = SCOPED_CGROUP.replace(LAUNCH_ID, '00000000-0000-4000-8000-000000000000');
    const proc = fakeProc(4242, [{ cgroup: otherScope, startTime: '777' }]);

    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(observation.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: otherScope, reason: { kind: 'bound-elapsed' } });
    // 50 ms polls inside a 2 s bound: reads at 0, 50, ..., 1950 ms.
    expect(proc.cgroupReads()).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reports scoped for the user manager\'s scope under another uid', async () => {
    const proc = fakeProc(4242, [{ cgroup: SCOPED_CGROUP, startTime: '777' }]);

    const observation = start({ pid: 4242, uid: 1001, unitName: UNIT, readProcFile: proc.readProcFile });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(observation.outcome).toMatchObject({ outcome: 'unknown', reason: { kind: 'bound-elapsed' } });
  });

  it('discards a scoped read when the PID now names a different process', async () => {
    const proc = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      // PID reuse: a new process with the right-looking cgroup but another start time.
      { cgroup: SCOPED_CGROUP, startTime: '999' },
    ]);

    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile });

    await vi.advanceTimersByTimeAsync(50);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'pid-gone' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports pid-gone when the process disappears, and read-error for other failures', async () => {
    const gone = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      'gone',
    ]);
    const goneObservation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: gone.readProcFile });
    await vi.advanceTimersByTimeAsync(50);
    expect(goneObservation.outcome).toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'pid-gone' } });

    const denied = fakeProc(4242, [Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })]);
    const deniedObservation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: denied.readProcFile });
    await vi.advanceTimersByTimeAsync(0);
    expect(deniedObservation.outcome).toEqual({
      outcome: 'unknown',
      lastCgroup: null,
      reason: { kind: 'read-error', message: 'EACCES: permission denied' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops trusting the PID once the owning ChildProcess has exited', async () => {
    const proc = fakeProc(4242, [{ cgroup: SCOPED_CGROUP, startTime: '777' }]);
    let exited = false;
    const readProcFile: ReadProcFile = async (path) => {
      const content = await proc.readProcFile(path);
      if (path.endsWith('/cgroup')) exited = true;
      return content;
    };

    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile, isKnownGone: () => exited });
    await vi.advanceTimersByTimeAsync(0);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'pid-gone' } });
  });

  it('ends at the bound when the first stat read never settles', async () => {
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile: () => never<string>() });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(observation.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at the bound when a cgroup read never settles, keeping the last completed read', async () => {
    const proc = fakeProc(4242, [{ cgroup: DAEMON_CGROUP, startTime: '777' }]);
    let cgroupReads = 0;
    const readProcFile: ReadProcFile = async (path) => {
      if (path.endsWith('/cgroup') && ++cgroupReads > 1) return await never<string>();
      return await proc.readProcFile(path);
    };
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'bound-elapsed' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a scoped read that completes after the bound, and stops polling', async () => {
    const proc = fakeProc(4242, [{ cgroup: SCOPED_CGROUP, startTime: '777' }]);
    const reads: string[] = [];
    const readProcFile: ReadProcFile = async (path) => {
      reads.push(path);
      if (path.endsWith('/cgroup')) {
        // Settles 500 ms after the bound with a matching scope path.
        await new Promise<void>((resolve) => { setTimeout(resolve, 2_500); });
      }
      return await proc.readProcFile(path);
    };
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
    const readsAtBound = reads.length;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
    // At most the identity re-check that belonged to the late read; no further polls.
    expect(reads.length).toBeLessThanOrEqual(readsAtBound + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resume polling when a first stat read that was pending at the bound resolves late', async () => {
    const reads: string[] = [];
    const readProcFile: ReadProcFile = async (path) => {
      reads.push(path);
      if (reads.length === 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 2_500); });
      }
      return path.endsWith('/stat') ? stat(4242, '777') : `0::${SCOPED_CGROUP}\n`;
    };
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
    expect(reads).toEqual(['/proc/4242/stat']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolves', 'rejects'] as const)(
    'never accepts a matching cgroup whose identity re-check was pending at the bound and %s late',
    async (lateSettlement) => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        let statReads = 0;
        const readProcFile: ReadProcFile = async (path) => {
          if (path.endsWith('/cgroup')) return `0::${SCOPED_CGROUP}\n`;
          statReads += 1;
          if (statReads === 1) return stat(4242, '777');
          // The re-check after a matching cgroup read hangs past the bound.
          await new Promise<void>((resolve) => { setTimeout(resolve, 2_500); });
          if (lateSettlement === 'rejects') throw Object.assign(new Error('EIO: late identity'), { code: 'EIO' });
          return stat(4242, '777');
        };
        const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
        expect(statReads).toBe(2);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    },
  );

  it('ends at the bound even when a matching scope would be seen on the next poll after it', async () => {
    // Prompt reads: non-matching through 1950 ms, matching from 2000 ms on.
    const readProcFile: ReadProcFile = async (path) => {
      if (path.endsWith('/stat')) return stat(4242, '777');
      return `0::${Date.now() >= 2_000 ? SCOPED_CGROUP : DAEMON_CGROUP}\n`;
    };
    vi.setSystemTime(0);
    const observation = start({ pid: 4242, uid: 1000, unitName: UNIT, readProcFile });

    await vi.advanceTimersByTimeAsync(2_100);
    expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'bound-elapsed' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a read that rejects after the bound', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const observation = start({
        pid: 4242,
        uid: 1000,
        unitName: UNIT,
        readProcFile: () => new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error('EIO: late'), { code: 'EIO' })), 3_000);
        }),
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
      await vi.advanceTimersByTimeAsync(2_000);
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observation.outcome).toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'bound-elapsed' } });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('resolveSessionLaunchPlacement', () => {
  it('reports an unscoped launch from its probe without reading /proc', async () => {
    const readProcFile = vi.fn<ReadProcFile>();

    await expect(resolveSessionLaunchPlacement({
      intent: { kind: 'unscoped', probe: { kind: 'no-user-bus' } },
      pid: 4242,
      uid: 1000,
      readProcFile,
    })).resolves.toEqual({ outcome: 'unscoped', probe: { kind: 'no-user-bus' } });
    expect(readProcFile).not.toHaveBeenCalled();
  });
});
