import { describe, expect, it, vi } from 'vitest';

import { startSingleFlightIntervalLoop } from './singleFlightIntervalLoop';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  if (!resolve) {
    throw new Error('Failed to create deferred');
  }
  return { promise, resolve };
}

describe('startSingleFlightIntervalLoop', () => {
  it('observes pending work, pause/resume and stop without changing single-flight scheduling', async () => {
    vi.useFakeTimers();
    try {
      const pending = createDeferred();
      const task = vi.fn(() => pending.promise);
      const observe = vi.fn();
      const loop = startSingleFlightIntervalLoop({ intervalMs: 10, task, onObservation: observe });
      loop.trigger();
      await vi.advanceTimersByTimeAsync(20);
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({
        event: 'skipped', reason: 'in_flight', inFlight: true, elapsedMs: 20,
      }));
      loop.pause();
      await vi.advanceTimersByTimeAsync(10);
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ event: 'skipped', reason: 'paused', paused: true }));
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ event: 'completed', outcome: 'success', elapsedMs: 30, inFlight: false }));
      loop.resume();
      await vi.advanceTimersByTimeAsync(10);
      expect(task).toHaveBeenCalledTimes(2);
      loop.stop();
      loop.trigger();
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ event: 'stopped', stopped: true }));
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ event: 'skipped', reason: 'stopped' }));
      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears failed work and preserves retries when an observation sink throws', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const task = vi.fn(async () => { if (fail) throw new Error('task failed'); });
      const events: unknown[] = [];
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10, task, failureBackoffMs: 20, onError: vi.fn(),
        onObservation: (event) => { events.push(event); throw new Error('diagnostic sink failed'); },
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(events).toContainEqual(expect.objectContaining({ event: 'completed', outcome: 'failure', inFlight: false }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'skipped', reason: 'failure_backoff' }));
      fail = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(3);
      expect(events).toContainEqual(expect.objectContaining({ event: 'completed', outcome: 'success' }));
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps task executions (single-flight)', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const second = createDeferred();
      let callCount = 0;
      const task = vi.fn(
        () => {
          callCount += 1;
          return callCount === 1 ? first.promise : second.promise;
        },
      );

      startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      first.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling new ticks after stop()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be triggered manually without waiting for the interval', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses interval scheduling until resume()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      loop.pause();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).not.toHaveBeenCalled();

      loop.resume();
      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unrefs the interval handle when requested', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
      unref,
    } as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    try {
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task: async () => {},
        unref: true,
      });

      expect(unref).toHaveBeenCalledTimes(1);
      loop.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('backs off automatic retries after failures and resets after success', async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = true;
      const task = vi.fn(async () => {
        if (shouldFail) {
          throw new Error('temporary outage');
        }
      });

      const loop = startSingleFlightIntervalLoop({
        intervalMs: 50,
        failureBackoffMs: 100,
        maxFailureBackoffMs: 100,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90);
      expect(task).toHaveBeenCalledTimes(1);

      shouldFail = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(3);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual trigger bypasses failure backoff', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {
        throw new Error('temporary outage');
      });
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        failureBackoffMs: 60_000,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(2);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
