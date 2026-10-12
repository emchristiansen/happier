import { describe, expect, it } from 'vitest';

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type {
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
    TranscriptWindowGapItem,
} from './transcriptTargetWindowTypes';

/**
 * Entry-slice reachability contract.
 *
 * `resolveTranscriptRenderWindowProjection` has TWO independent withholding stages, and only the
 * second one owns the gap affordance:
 *
 *   1. the entry slice (`resolveActiveEntrySliceBounds`) slices `params.items` around the entry
 *      restore anchor;
 *   2. the target window (`resolveTranscriptTargetWindowHostFacts`) runs on the ALREADY-SLICED
 *      list and emits the older/newer gap rows.
 *
 * Because stage 2 never sees what stage 1 removed, entry-slice-withheld rows can carry no gap
 * affordance. These tests pin exactly what that costs and exactly how far it reaches, so a later
 * change cannot quietly widen it:
 *
 *   - it is native-only (never arms on web);
 *   - it withholds a contiguous NEWER suffix, never a middle hole;
 *   - the withheld rows are silently absent while it is armed;
 *   - clearing the slice restores every row, so it is a transient first-paint bound and not a
 *     permanent loss of reachability.
 */

type TestMessageItem = Readonly<{
    id: string;
    kind: 'message';
    messageId: string;
    seq: number;
}>;
type TestItem = TestMessageItem | TranscriptWindowGapItem;

const inactiveWindow: TranscriptTargetWindowState = {
    activatedAtMs: null,
    hasMoreNewer: null,
    hasMoreOlder: null,
    isWindowMode: false,
    newerCursor: null,
    olderCursor: null,
    targetSeq: null,
    windowId: null,
    windowMaxSeq: null,
    windowMinSeq: null,
};

function item(seq: number): TestMessageItem {
    return { id: `row-${seq}`, kind: 'message', messageId: `msg-${seq}`, seq };
}

function gapItem(gap: TranscriptWindowGapDescriptor): TranscriptWindowGapItem {
    return { ...gap, kind: 'transcript-window-gap' };
}

const sourceItems: readonly TestItem[] = [1, 2, 3, 4, 5, 6, 7, 8].map(item);

function project(overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {}) {
    return resolveTranscriptRenderWindowProjection<TestItem>({
        activeThinkingMessageId: null,
        createWindowGapItem: gapItem,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set(),
        items: sourceItems,
        listOrientation: 'standard' satisfies TranscriptListOrientation,
        liveTailAnchorMessageId: null,
        platformOS: 'web',
        rendererKind: 'legendList',
        sessionId: 'session-1',
        targetWindowState: inactiveWindow,
        transcriptNativeHotTailItemCount: 0,
        transcriptWebHotTailItemCount: 0,
        ...overrides,
    });
}

/** Native transcripts render inverted; the entry slice only exists there. */
function projectNative(overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {}) {
    return project({ listOrientation: 'inverted', platformOS: 'ios', ...overrides });
}

function presentedIds(projection: ReturnType<typeof project>): readonly string[] {
    return projection.canonicalWindowedItems.map((entry) => entry.id);
}

describe('transcript entry slice reachability', () => {
    it('never arms on web, so a web transcript withholds nothing before the target window', () => {
        // The reported symptom was seen in the browser. This is the discriminating check: with an
        // entry slice window supplied verbatim, web still projects every source row.
        const projection = project({ entrySliceWindow: { anchorRowId: 'row-4', sessionId: 'session-1' } });

        expect(projection.entrySlice.bounds).toBeNull();
        expect(projection.entrySlice.withheldCount).toBe(0);
        expect(presentedIds(projection)).toEqual(sourceItems.map((entry) => entry.id));
    });

    it('withholds the NEWER suffix on native and gives those rows no gap affordance', () => {
        const projection = projectNative({
            entrySliceWindow: { anchorRowId: 'row-4', sessionId: 'session-1' },
        });

        // Inverted bounds are { start: 0, end: anchorSourceIndex + 1 }: rows 5..8 are withheld.
        expect(projection.entrySlice.bounds).toEqual({ start: 0, end: 4 });
        expect(projection.entrySlice.withheldCount).toBe(4);

        const presented = new Set(presentedIds(projection));
        expect([...presented].sort()).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);

        // The withheld rows sit on the NEWER side of the presented run and there is no newer gap
        // row describing them: while the slice is armed they are unreachable by scrolling.
        expect(projection.targetWindow.gaps.newer).toBeNull();
        expect(projection.targetWindow.gaps.older).toBeNull();
        for (const withheld of ['row-5', 'row-6', 'row-7', 'row-8']) {
            expect(presented.has(withheld)).toBe(false);
        }
    });

    it('keeps the sliced run contiguous — the entry slice can never punch a middle hole', () => {
        const projection = projectNative({
            entrySliceWindow: { anchorRowId: 'row-6', sessionId: 'session-1' },
        });
        const presentedSourceIndices = sourceItems
            .map((entry, index) => (presentedIds(projection).includes(entry.id) ? index : null))
            .filter((index): index is number => index !== null);

        expect(presentedSourceIndices).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('restores every withheld row once the slice is released', () => {
        // `useTranscriptEntrySliceReveal` clears `entrySliceWindow`; this is the projection-side
        // half of that contract. The withholding is a first-paint bound, not a data loss.
        const armed = projectNative({ entrySliceWindow: { anchorRowId: 'row-4', sessionId: 'session-1' } });
        const released = projectNative({ entrySliceWindow: null });

        expect(armed.entrySlice.withheldCount).toBe(4);
        expect(released.entrySlice.withheldCount).toBe(0);
        expect([...presentedIds(released)].sort()).toEqual(
            sourceItems.map((entry) => entry.id).slice().sort(),
        );
    });

    it('does not arm for a slice window belonging to another session', () => {
        const projection = projectNative({
            entrySliceWindow: { anchorRowId: 'row-4', sessionId: 'other-session' },
        });

        expect(projection.entrySlice.bounds).toBeNull();
        expect(projection.entrySlice.withheldCount).toBe(0);
    });

    it('is identity on web in tail mode: the projection withholds nothing at all', () => {
        // Scope-narrowing evidence for the reported browser symptom. With no target window and no
        // tail discontinuity floor — the state of an ordinary session being scrolled — every
        // source row is projected, so a row missing from a web transcript was already missing from
        // `params.items` and its owner is upstream of this module.
        const manyItems = Array.from({ length: 200 }, (_, index) => item(index + 1));
        const projection = project({ items: manyItems });

        expect(presentedIds(projection)).toEqual(manyItems.map((entry) => entry.id));
        expect(projection.targetWindow.gaps.older).toBeNull();
        expect(projection.targetWindow.gaps.newer).toBeNull();
        expect(projection.entrySlice.withheldCount).toBe(0);
    });

    it('announces the tail discontinuity floor with an older gap row on web', () => {
        // The one web tail-mode withholding path. It removes a contiguous OLDER prefix and always
        // pairs it with the affordance, so it cannot produce a hole between two visible rows.
        const projection = project({ tailContiguousBoundary: { kind: 'seq', seq: 5 } });

        expect(presentedIds(projection)).toEqual([
            'transcript-window-gap:tail:older',
            'row-5',
            'row-6',
            'row-7',
            'row-8',
        ]);
    });

    it('blanks a target window whose target seq was removed by the entry slice', () => {
        // Composition hazard, pinned so it cannot regress into a live path: the target window runs
        // on `entrySliceItems`, so a jump target in the withheld suffix has no owning group and the
        // window renders nothing. The pipeline clears the slice on `jumpToSeq`
        // (items/useTranscriptItemsPipeline.tsx:302-305), which is what keeps this unreachable.
        const projection = projectNative({
            entrySliceWindow: { anchorRowId: 'row-4', sessionId: 'session-1' },
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 7,
                windowId: 'w1',
                windowMaxSeq: 8,
                windowMinSeq: 6,
            },
        });

        expect(projection.targetWindow.display?.targetPresent).toBe(false);
        expect(projection.targetWindow.items).toEqual([]);
    });
});
