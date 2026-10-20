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
  it('preserves the queued caller ancestry when another owner hands off the lock', async () => {
    vi.useFakeTimers();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let releaseB!: () => void;
    const heldB = locks.runExclusive('b', () => new Promise<void>((resolve) => { releaseB = resolve; }));
    let reenteredA = false;
    const nested = locks.runExclusive('a', async () => locks.runExclusive('b', async () => (
      locks.runExclusive('a', async () => {
        reenteredA = true;
        return 'completed';
      })
    )));
    const outcome = nested.then(
      (value) => ({ status: 'completed' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );

    try {
      releaseB();
      await heldB;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toEqual({ status: 'completed', value: 'completed' });
      expect(reenteredA).toBe(true);
    } finally {
      releaseB();
      locks.clearSession('a');
      locks.clearSession('b');
      await Promise.allSettled([heldB, nested]);
      vi.useRealTimers();
    }
  });

  it('does not transfer a live ancestor capability to an unrelated queued caller', async () => {
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let releaseB!: () => void;
    let releaseA!: () => void;
    const aCanFinish = new Promise<void>((resolve) => { releaseA = resolve; });
    const events: string[] = [];
    const outer = locks.runExclusive('a', async () => {
      await locks.runExclusive('b', () => new Promise<void>((resolve) => { releaseB = resolve; }));
      await aCanFinish;
      events.push('outer:a:end');
    });
    let attemptedA!: () => void;
    const aWasRequested = new Promise<void>((resolve) => { attemptedA = resolve; });
    let unrelatedAStarted = false;
    const unrelated = locks.runExclusive('b', async () => {
      const requestedA = locks.runExclusive('a', async () => {
        unrelatedAStarted = true;
        events.push('unrelated:a');
      });
      attemptedA();
      await requestedA;
    });

    try {
      releaseB();
      await aWasRequested;
      expect(unrelatedAStarted).toBe(false);
      releaseA();
      await Promise.all([outer, unrelated]);
      expect(events).toEqual(['outer:a:end', 'unrelated:a']);
    } finally {
      releaseB();
      releaseA();
      locks.clearSession('a');
      locks.clearSession('b');
      await Promise.allSettled([outer, unrelated]);
    }
  });

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
