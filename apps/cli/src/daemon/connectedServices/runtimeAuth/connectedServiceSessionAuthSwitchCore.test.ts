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

describe('deferred background acquisition', () => {
  it('outlives the ordinary bound on the shared FIFO queue while an ordinary waiter beside it expires', async () => {
    vi.useFakeTimers();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let release!: () => void;
    const held = locks.runExclusive('s1', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const events: string[] = [];
    let ordinaryOutcome: unknown;
    const ordinary = locks.runExclusive('s1', async () => { events.push('ordinary'); })
      .catch((error: unknown) => { ordinaryOutcome = error; });
    const background = locks.runExclusiveDeferredBackground('s1', async () => {
      events.push('background');
      return 'applied';
    }).then(
      (value) => ({ status: 'completed' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
    let later: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      // Queued behind the background acquisition; its own 30 s bound runs until t = 40 s.
      later = locks.runExclusive('s1', async () => { events.push('later'); });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(ordinaryOutcome).toMatchObject({ reason: 'timed_out', sessionId: 's1' });
      expect(events).toEqual([]);
      release();
      await held;
      await expect(background).resolves.toEqual({ status: 'completed', value: 'applied' });
      await later;
      await ordinary;
      expect(events).toEqual(['background', 'later']);
    } finally {
      release();
      locks.clearSession('s1');
      await Promise.allSettled([held, ordinary, background, ...(later ? [later] : [])]);
      vi.useRealTimers();
    }
  });

  it('keeps the queued caller ancestry and re-enters at once, with no acquisition timeout', async () => {
    vi.useFakeTimers();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let releaseB!: () => void;
    const heldB = locks.runExclusive('b', () => new Promise<void>((resolve) => { releaseB = resolve; }));
    await Promise.resolve();
    const events: string[] = [];
    const nested = locks.runExclusive('a', async () => await locks.runExclusiveDeferredBackground('b', async () => {
      events.push('b');
      // Both the queued caller's own lock and the background owner's lock re-enter at once.
      await locks.runExclusiveDeferredBackground('b', async () => { events.push('b:reentered'); });
      return await locks.runExclusive('a', async () => {
        events.push('a:reentered');
        return 'completed';
      });
    })).then(
      (value) => ({ status: 'completed' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(events).toEqual([]);
      releaseB();
      await heldB;
      await expect(nested).resolves.toEqual({ status: 'completed', value: 'completed' });
      expect(events).toEqual(['b', 'b:reentered', 'a:reentered']);
    } finally {
      releaseB();
      locks.clearSession('a');
      locks.clearSession('b');
      await Promise.allSettled([heldB, nested]);
      vi.useRealTimers();
    }
  });

  it('is cancelled by clearSession while queued, and never runs later or requeues', async () => {
    vi.useFakeTimers();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    let release!: () => void;
    const held = locks.runExclusive('s1', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const executed: string[] = [];
    let backgroundOutcome: unknown;
    const background = locks.runExclusiveDeferredBackground('s1', async () => { executed.push('stopped'); })
      .catch((error: unknown) => { backgroundOutcome = error; });
    try {
      locks.clearSession('s1');
      await background;
      expect(backgroundOutcome).toMatchObject({ reason: 'session_stopped', sessionId: 's1' });
      // The running owner keeps its exclusion through Stop.
      expect(locks.isHeldByAnotherOwner('s1')).toBe(true);
      release();
      await held;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(executed).toEqual([]);
      expect(locks.isHeldByAnotherOwner('s1')).toBe(false);
    } finally {
      release();
      await Promise.allSettled([held, background]);
      vi.useRealTimers();
    }
  });
});
