import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionLeadingTrailingCoalescer,
    createSessionShellRefreshCoalescer,
} from './sessionShellRefreshCoalescer';

describe('createSessionShellRefreshCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('triggers immediately on the first request for a session', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');

        expect(trigger).toHaveBeenCalledTimes(1);
        expect(trigger).toHaveBeenCalledWith('s1');
    });

    it('coalesces a burst within the floor into a single trailing trigger', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');
        coalescer.request('s1');
        coalescer.request('s1');
        coalescer.request('s1');

        expect(trigger).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(4_999);
        expect(trigger).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        expect(trigger).toHaveBeenCalledTimes(2);
        expect(trigger).toHaveBeenLastCalledWith('s1');
    });

    it('does not schedule a trailing trigger when no request arrived after the leading one', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');
        vi.advanceTimersByTime(60_000);

        expect(trigger).toHaveBeenCalledTimes(1);
    });

    it('triggers immediately again once the floor has elapsed', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');
        vi.advanceTimersByTime(5_000);
        coalescer.request('s1');

        expect(trigger).toHaveBeenCalledTimes(2);
    });

    it('tracks sessions independently', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');
        coalescer.request('s2');

        expect(trigger).toHaveBeenCalledTimes(2);
        expect(trigger).toHaveBeenNthCalledWith(1, 's1');
        expect(trigger).toHaveBeenNthCalledWith(2, 's2');

        coalescer.request('s1');
        coalescer.request('s2');
        vi.advanceTimersByTime(5_000);

        expect(trigger).toHaveBeenCalledTimes(4);
    });

    it('reset clears pending trailing triggers and floor state', () => {
        const trigger = vi.fn();
        const coalescer = createSessionShellRefreshCoalescer({ floorMs: 5_000, trigger });

        coalescer.request('s1');
        coalescer.request('s1');
        coalescer.reset();

        vi.advanceTimersByTime(60_000);
        expect(trigger).toHaveBeenCalledTimes(1);

        coalescer.request('s1');
        expect(trigger).toHaveBeenCalledTimes(2);
    });

    it('delivers the latest payload to the single trailing trigger', () => {
        const trigger = vi.fn();
        const coalescer = createSessionLeadingTrailingCoalescer<number>({ floorMs: 5_000, trigger });

        coalescer.request('s1', 1);
        coalescer.request('s1', 2);
        coalescer.request('s1', 3);
        vi.advanceTimersByTime(5_000);

        expect(trigger).toHaveBeenCalledTimes(2);
        expect(trigger).toHaveBeenNthCalledWith(1, 's1', 1);
        expect(trigger).toHaveBeenNthCalledWith(2, 's1', 3);
    });
});
