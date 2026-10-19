import { afterEach, expect, it, vi } from 'vitest';

import { createBackoff } from './time';

afterEach(() => { vi.useRealTimers(); });

it('keeps a server retry floor beyond the native timer ceiling without an early request', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const serverDelayMs = 2_147_483_647 + 60_000;
    const unavailable = Object.assign(new Error('synthetic permission read unavailable'), { retryAfterMs: serverDelayMs });
    const read = vi.fn(async () => {
        if (read.mock.calls.length === 1) throw unavailable;
        return 'authoritative response';
    });
    const retry = createBackoff({ retryAfterMs: (error) => error === unavailable ? unavailable.retryAfterMs : undefined });
    const response = retry(read);
    try {
        await vi.advanceTimersByTimeAsync(serverDelayMs - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(response).resolves.toBe('authoritative response');
        expect(read).toHaveBeenCalledTimes(2);
    } finally {
        await vi.runAllTimersAsync();
        await response;
    }
});
