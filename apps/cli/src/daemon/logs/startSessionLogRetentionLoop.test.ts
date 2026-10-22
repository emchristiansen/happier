import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_LOG_SWEEP_INTERVAL_MS } from '@/utils/logs/logRetention';
import { startSessionLogRetentionLoop } from './startSessionLogRetentionLoop';

describe('startSessionLogRetentionLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sweeps once at start, then hourly, and never again after stop', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => ({ deleted: 0 }));
    const onTickError = vi.fn();

    const loop = startSessionLogRetentionLoop({ sweep, onTickError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SESSION_LOG_SWEEP_INTERVAL_MS - 1);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(SESSION_LOG_SWEEP_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      loop.stop();
    }

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * SESSION_LOG_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(onTickError).not.toHaveBeenCalled();
  });

  it('runs the interval on an unref\'d timer so it never keeps the daemon alive', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const loop = startSessionLogRetentionLoop({ sweep: async () => ({ deleted: 0 }), onTickError: vi.fn() });
    try {
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), SESSION_LOG_SWEEP_INTERVAL_MS);
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      loop.stop();
    }
  });

  it('reports a failed sweep and keeps sweeping on the next tick', async () => {
    vi.useFakeTimers();
    const failure = new Error('sweep failed');
    const sweep = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ deleted: 0 });
    const onTickError = vi.fn();

    const loop = startSessionLogRetentionLoop({ sweep, onTickError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onTickError).toHaveBeenCalledWith(failure);
      await vi.advanceTimersByTimeAsync(SESSION_LOG_SWEEP_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      loop.stop();
    }
  });
});
