import { describe, expect, it } from 'vitest';
import { resolveChatHeaderContentInsets } from './chatHeaderLayout';

describe('chat header alignment', () => {
    it.each([44, 52, 56])('aligns the leading edge with content excluding a %ipx rail while retaining the trailing edge', (railWidth) => {
        const fullHeader = resolveChatHeaderContentInsets({ containerWidth: 1200, maxWidth: 850, contentTrailingInsetPx: 0, constrainWidth: true });
        const transcript = resolveChatHeaderContentInsets({ containerWidth: 1200 - railWidth, maxWidth: 850, contentTrailingInsetPx: 0, constrainWidth: true });
        const header = resolveChatHeaderContentInsets({ containerWidth: 1200, maxWidth: 850, contentTrailingInsetPx: railWidth, constrainWidth: true });
        expect(header.leading).toBe(transcript.leading);
        expect(header.trailing).toBe(fullHeader.trailing);
    });

    it('keeps content flush when the rail takes the transcript below the width cap', () => {
        expect(resolveChatHeaderContentInsets({ containerWidth: 870, maxWidth: 850, contentTrailingInsetPx: 44, constrainWidth: true })).toEqual({ leading: 0, trailing: 10 });
    });

    it.each([
        { containerWidth: 390, maxWidth: 850, contentTrailingInsetPx: 0, constrainWidth: true },
        { containerWidth: 1200, maxWidth: Infinity, contentTrailingInsetPx: 44, constrainWidth: true },
        { containerWidth: 1200, maxWidth: 850, contentTrailingInsetPx: 44, constrainWidth: false },
    ])('preserves phone, full-width, and unconstrained pane layouts: %o', (input) => {
        expect(resolveChatHeaderContentInsets(input)).toEqual({ leading: 0, trailing: 0 });
    });
});
