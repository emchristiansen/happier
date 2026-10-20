import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';

describe('connectedServiceSessionAuthSwitchCore', () => {
  it('allows the same async transition to re-enter the same session lock', async () => {
    const core = createConnectedServiceSessionAuthSwitchCore({
      locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
    });
    const events: string[] = [];

    const transition = core.run({
      sessionId: 'session-1',
      reason: 'automatic_runtime_failure',
      execute: async () => {
        events.push('outer:start');
        const inner = await core.run({
          sessionId: 'session-1',
          reason: 'manual',
          execute: async () => {
            events.push('inner');
            return 'inner-result';
          },
        });
        events.push(`outer:${inner}`);
        return 'outer-result';
      },
    });

    const result = await Promise.race([
      transition.then((value) => ({ kind: 'resolved' as const, value })),
      new Promise<{ kind: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timed_out' }), 25);
      }),
    ]);

    expect(result).toEqual({ kind: 'resolved', value: 'outer-result' });
    expect(events).toEqual(['outer:start', 'inner', 'outer:inner-result']);
  });

  it('serializes concurrent switches for the same session', async () => {
    const core = createConnectedServiceSessionAuthSwitchCore({
      locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = core.run({
      sessionId: 'session-1',
      reason: 'automatic_runtime_failure',
      execute: async () => {
        events.push('first:start');
        await firstCanFinish;
        events.push('first:end');
        return { status: 'first' as const };
      },
    });

    await Promise.resolve();

    const second = core.run({
      sessionId: 'session-1',
      reason: 'manual',
      execute: async () => {
        events.push('second:start');
        return { status: 'second' as const };
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(first).resolves.toEqual({ status: 'first' });
    await expect(second).resolves.toEqual({ status: 'second' });
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});

describe('queued auth switch cancellation', () => {
  it('bounds queued acquisition without releasing a running owner or executing an expired node later', async () => {
    vi.useFakeTimers();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let release!: () => void;
    const held = locks.runExclusive('s1', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const executed: string[] = [];
    let queuedOutcome: unknown;
    const queued = locks.runExclusive('s1', async () => { executed.push('expired'); })
      .catch((error: unknown) => { queuedOutcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(queuedOutcome).toMatchObject({ reason: 'timed_out', sessionId: 's1' });
      let successorStarted = false;
      const successor = locks.runExclusive('s1', async () => { successorStarted = true; });
      await Promise.resolve();
      expect(successorStarted).toBe(false);
      release();
      await Promise.all([held, queued, successor]);
      expect(successorStarted).toBe(true);
      expect(executed).toEqual([]);
    } finally {
      release();
      await Promise.all([held, queued]);
      vi.useRealTimers();
    }
  });

  it('settles stopped waiters immediately and keeps new work excluded until the running owner finishes', async () => {
    const core = createConnectedServiceSessionAuthSwitchCore();
    let release!: () => void;
    const held = core.run({
      sessionId: 's1',
      reason: 'manual',
      execute: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await Promise.resolve();
    const executed: string[] = [];
    let queuedOutcome: unknown;
    const queued = core.run({
      sessionId: 's1', reason: 'automatic_runtime_failure',
      execute: async () => { executed.push('stopped'); },
    }).catch((error: unknown) => { queuedOutcome = error; });
    core.clearSession('s1');
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await expect.poll(() => queuedOutcome).toMatchObject({ reason: 'session_stopped', sessionId: 's1' });
      const successor = core.run({
        sessionId: 's1', reason: 'manual',
        execute: async () => { executed.push('successor'); },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(executed).toEqual([]);
      release();
      await Promise.all([held, queued, successor]);
      expect(executed).toEqual(['successor']);
    } finally {
      release();
      await Promise.all([held, queued]);
    }
  });
});
