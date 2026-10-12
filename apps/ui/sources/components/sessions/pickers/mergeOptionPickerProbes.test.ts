import { describe, expect, it } from 'vitest';
import { mergeOptionPickerProbes } from './mergeOptionPickerProbes';

describe('mergeOptionPickerProbes', () => {
    it('retains a failed probe alongside another successful probe and preserves retry', () => {
        let refreshed = false;
        const merged = mergeOptionPickerProbes([
            { phase: 'idle', error: true, onRefresh: () => { refreshed = true; } },
            { phase: 'idle', error: false },
        ]);
        expect(merged?.error).toBe(true);
        merged?.onRefresh?.();
        expect(refreshed).toBe(true);
    });

    it('keeps terminal failure visible even when no refresh callback is available', () => {
        expect(mergeOptionPickerProbes([{ phase: 'idle', error: true }])?.error).toBe(true);
        expect(mergeOptionPickerProbes([{ phase: 'idle', error: false }])).toBeUndefined();
    });
});
