import { describe, expect, it } from 'vitest';

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type {
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
    TranscriptWindowGapItem,
} from './transcriptTargetWindowTypes';

/**
 * Reachability contract for the transcript render window.
 *
 * The projection is allowed to withhold loaded rows — that is what bounds render cost on a
 * large transcript. It is NOT allowed to withhold them SILENTLY: a reader scrolling through
 * the transcript must be able to tell that something was left out, and in which direction.
 *
 * The invariant that makes edge gap rows sufficient is that the presented run is a CONTIGUOUS
 * span of the source item list. Once a run has holes punched in its middle, no older/newer edge
 * marker can describe them, and the omitted rows become unreachable with no affordance at all.
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

/** A row the transcript renders without any resolvable seq — a fork divider or pending block. */
function seqlessItem(id: string): TestMessageItem {
    return { id, kind: 'message', messageId: `msg-${id}` } as unknown as TestMessageItem;
}

function gapItem(gap: TranscriptWindowGapDescriptor): TranscriptWindowGapItem {
    return { ...gap, kind: 'transcript-window-gap' };
}

function project(overrides: Partial<Parameters<typeof resolveTranscriptRenderWindowProjection<TestItem>>[0]> = {}) {
    return resolveTranscriptRenderWindowProjection<TestItem>({
        activeThinkingMessageId: null,
        createWindowGapItem: gapItem,
        entrySliceWindow: null,
        expandedToolCallsAnchorMessageIds: new Set(),
        items: [1, 2, 3, 4, 5, 6].map(item),
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

/**
 * Rows the reader can reach without an affordance, i.e. source rows that are neither presented
 * nor separated from the presented run by a gap row on the side they actually sit on.
 */
function resolveSilentlyUnreachableIds(
    projection: ReturnType<typeof project>,
    sourceItems: readonly TestItem[],
): readonly string[] {
    const presented = new Set(projection.canonicalWindowedItems.map((entry) => entry.id));
    const presentedSourceIndices = sourceItems
        .map((entry, index) => (presented.has(entry.id) ? index : null))
        .filter((index): index is number => index !== null);
    if (presentedSourceIndices.length === 0) {
        return sourceItems.filter((entry) => !presented.has(entry.id)).map((entry) => entry.id);
    }
    const firstPresented = presentedSourceIndices[0]!;
    const lastPresented = presentedSourceIndices[presentedSourceIndices.length - 1]!;
    const hasOlderGap = projection.targetWindow.gaps.older !== null;
    const hasNewerGap = projection.targetWindow.gaps.newer !== null;
    const unreachable: string[] = [];
    sourceItems.forEach((entry, index) => {
        if (presented.has(entry.id)) return;
        if (index < firstPresented) {
            if (!hasOlderGap) unreachable.push(entry.id);
            return;
        }
        if (index > lastPresented) {
            if (!hasNewerGap) unreachable.push(entry.id);
            return;
        }
        // Inside the presented run: no edge marker can ever describe this row.
        unreachable.push(entry.id);
    });
    return unreachable;
}

describe('transcript render window reachability', () => {
    it('keeps a target window contiguous when a seqless row sits inside the presented run', () => {
        // A fork divider / pending block carries no seq, so it is not a window seq candidate —
        // but it sits between two rows the window does present.
        const items: TestItem[] = [item(10), seqlessItem('row-fork'), item(11)];
        const projection = project({
            items,
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 11,
                windowId: 'w1',
                windowMaxSeq: 20,
                windowMinSeq: 5,
            },
        });

        expect(resolveSilentlyUnreachableIds(projection, items)).toEqual([]);
        expect(projection.canonicalWindowedItems.map((entry) => entry.id))
            .toEqual(['row-10', 'row-fork', 'row-11']);
    });

    it('keeps a target window contiguous when a decomposition row carries an out-of-range seq', () => {
        // Decomposed item seqs are locally non-monotonic (a tool group anchors on its FIRST
        // call while neighbouring units already covered later seqs), so a row whose seq falls
        // outside the window range can sit between two in-range rows.
        const items: TestItem[] = [item(10), item(99), item(11)];
        const projection = project({
            items,
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 11,
                windowId: 'w1',
                windowMaxSeq: 20,
                windowMinSeq: 5,
            },
        });

        expect(resolveSilentlyUnreachableIds(projection, items)).toEqual([]);
        expect(projection.canonicalWindowedItems.map((entry) => entry.id))
            .toEqual(['row-10', 'row-99', 'row-11']);
    });

    it('marks loaded rows omitted on each side of a target window with the matching gap row', () => {
        const items = [1, 2, 3, 10, 11, 20, 21].map(item);
        const projection = project({
            items,
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 11,
                windowId: 'w1',
                windowMaxSeq: 12,
                windowMinSeq: 9,
            },
        });

        expect(resolveSilentlyUnreachableIds(projection, items)).toEqual([]);
        expect(projection.canonicalWindowedItems.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:w1:older',
            'row-10',
            'row-11',
            'transcript-window-gap:w1:newer',
        ]);
    });

    it('keeps the island whole when a below-floor anchor sits inside it', () => {
        // row-2 anchors below the discontinuity floor but sits inside the live-tail island in
        // list order. Filtering it out leaves a hole the older gap row cannot describe.
        const items: TestItem[] = [item(10), item(2), item(11), item(12)];
        const projection = project({ items, tailContiguousBoundary: { kind: 'seq', seq: 5 } });

        expect(resolveSilentlyUnreachableIds(projection, items)).toEqual([]);
        // The older gap row stays: the discontinuity walk still has un-fetched older content
        // behind it. What changes is that it now leads a run with no holes punched below it.
        expect(projection.canonicalWindowedItems.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:tail:older',
            'row-10',
            'row-2',
            'row-11',
            'row-12',
        ]);
    });

    it('still withholds the stale prefix below the tail floor behind an older gap row', () => {
        const items = [1, 2, 3, 4, 5, 6].map(item);
        const projection = project({ items, tailContiguousBoundary: { kind: 'seq', seq: 4 } });

        expect(resolveSilentlyUnreachableIds(projection, items)).toEqual([]);
        expect(projection.canonicalWindowedItems.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:tail:older',
            'row-4',
            'row-5',
            'row-6',
        ]);
    });
});
