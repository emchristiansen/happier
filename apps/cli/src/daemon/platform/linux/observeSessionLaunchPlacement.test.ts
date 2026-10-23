import { describe, expect, it, vi } from 'vitest';

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

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => { now += ms; }),
  };
}

describe('observeSessionLaunchPlacement', () => {
  it('reports scoped once the same process is seen inside this attempt\'s scope', async () => {
    const proc = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: SCOPED_CGROUP, startTime: '777' },
    ]);
    const time = clock();

    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile, ...time,
    })).resolves.toEqual({ outcome: 'scoped', unitName: UNIT });
    expect(proc.cgroupReads()).toBe(3);
    expect(time.sleep).toHaveBeenCalledWith(50);
  });

  it('never reports scoped for another attempt\'s scope; it reports unknown when the bound elapses', async () => {
    const otherScope = SCOPED_CGROUP.replace(LAUNCH_ID, '00000000-0000-4000-8000-000000000000');
    const proc = fakeProc(4242, [{ cgroup: otherScope, startTime: '777' }]);

    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile, ...clock(),
    })).resolves.toEqual({ outcome: 'unknown', lastCgroup: otherScope, reason: { kind: 'bound-elapsed' } });
    // 50 ms polls over a 2 s bound: the first read plus one per elapsed interval.
    expect(proc.cgroupReads()).toBe(41);
  });

  it('never reports scoped for the user manager\'s scope under another uid', async () => {
    const proc = fakeProc(4242, [{ cgroup: SCOPED_CGROUP, startTime: '777' }]);

    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1001, unitName: UNIT, readProcFile: proc.readProcFile, ...clock(),
    })).resolves.toMatchObject({ outcome: 'unknown', reason: { kind: 'bound-elapsed' } });
  });

  it('discards a scoped read when the PID now names a different process', async () => {
    const proc = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      // PID reuse: a new process with the right-looking cgroup but another start time.
      { cgroup: SCOPED_CGROUP, startTime: '999' },
    ]);

    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile: proc.readProcFile, ...clock(),
    })).resolves.toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'pid-gone' } });
  });

  it('reports pid-gone when the process disappears, and read-error for other failures', async () => {
    const gone = fakeProc(4242, [
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      { cgroup: DAEMON_CGROUP, startTime: '777' },
      'gone',
    ]);
    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile: gone.readProcFile, ...clock(),
    })).resolves.toEqual({ outcome: 'unknown', lastCgroup: DAEMON_CGROUP, reason: { kind: 'pid-gone' } });

    const denied = fakeProc(4242, [Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })]);
    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile: denied.readProcFile, ...clock(),
    })).resolves.toEqual({
      outcome: 'unknown',
      lastCgroup: null,
      reason: { kind: 'read-error', message: 'EACCES: permission denied' },
    });
  });

  it('stops trusting the PID once the owning ChildProcess has exited', async () => {
    const proc = fakeProc(4242, [{ cgroup: SCOPED_CGROUP, startTime: '777' }]);
    let exited = false;
    const readProcFile: ReadProcFile = async (path) => {
      const content = await proc.readProcFile(path);
      if (path.endsWith('/cgroup')) exited = true;
      return content;
    };

    await expect(observeSessionLaunchPlacement({
      pid: 4242, uid: 1000, unitName: UNIT, readProcFile, isKnownGone: () => exited, ...clock(),
    })).resolves.toEqual({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'pid-gone' } });
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
