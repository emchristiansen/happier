import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOG_RETENTION_INTERVAL_MS } from '@/utils/logs/logRetention';
import { startLogRetentionLoop } from './startLogRetentionLoop';

describe('startLogRetentionLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs retention once at start, then hourly, and never again after stop', async () => {
    vi.useFakeTimers();
    const runRetention = vi.fn(async () => undefined);
    const onTickError = vi.fn();

    const loop = startLogRetentionLoop({ runRetention, onTickError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runRetention).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(LOG_RETENTION_INTERVAL_MS - 1);
      expect(runRetention).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runRetention).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(LOG_RETENTION_INTERVAL_MS);
      expect(runRetention).toHaveBeenCalledTimes(3);
    } finally {
      loop.stop();
    }

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * LOG_RETENTION_INTERVAL_MS);
    expect(runRetention).toHaveBeenCalledTimes(3);
    expect(onTickError).not.toHaveBeenCalled();
  });

  it('runs the interval on an unref\'d timer so it never keeps the daemon alive', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const loop = startLogRetentionLoop({ runRetention: async () => undefined, onTickError: vi.fn() });
    try {
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), LOG_RETENTION_INTERVAL_MS);
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      loop.stop();
    }
  });

  it('reports a failed pass and keeps running on the next tick', async () => {
    vi.useFakeTimers();
    const failure = new Error('retention failed');
    const runRetention = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const onTickError = vi.fn();

    const loop = startLogRetentionLoop({ runRetention, onTickError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onTickError).toHaveBeenCalledWith(failure);
      await vi.advanceTimersByTimeAsync(LOG_RETENTION_INTERVAL_MS);
      expect(runRetention).toHaveBeenCalledTimes(2);
    } finally {
      loop.stop();
    }
  });
});
