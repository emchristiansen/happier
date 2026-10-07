import { describe, expect, it } from 'vitest';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { collectTranscriptNavigationMessageIdsForItem } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import {
    resolveItemsToNewerEdge,
    resolveItemsToOlderEdge,
} from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import { createNativeInvertedFlashListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeInvertedFlashListFacts';
import { createNativeStandardListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeStandardListFacts';
import { resolveTranscriptRenderWindowProjection } from './resolveTranscriptRenderWindowProjection';
import type {
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
    TranscriptWindowGapItem,
} from './transcriptTargetWindowTypes';

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
    return {
        id: `row-${seq}`,
        kind: 'message',
        messageId: `msg-${seq}`,
        seq,
    };
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

describe('resolveTranscriptRenderWindowProjection', () => {
    it.each(['standard', 'inverted'] as const)('keeps an opaque island and grouped rows whole in %s orientation', (listOrientation) => {
        const items: TranscriptRowShellItem[] = [
            { kind: 'message', id: 'old-row', messageId: 'old', createdAt: 100, seq: null },
            { kind: 'turn', id: 'turn', turn: { id: 'turn', userMessageId: null, content: [{ kind: 'tool_calls', id: 'tools', toolMessageIds: ['tail-tool'] }] } },
            { kind: 'tool-group-tool', id: 'tool-unit', groupId: 'tools', toolMessageId: 'later-tool', toolMessageIds: ['tail-tool', 'later-tool'], expanded: true, createdAt: 1, seq: null },
            { kind: 'message', id: 'tail-row', messageId: 'tail', createdAt: 0, seq: null },
        ];
        const projection = resolveTranscriptRenderWindowProjection({
            activeThinkingMessageId: null, createWindowGapItem: gapItem,
            entrySliceWindow: null, expandedToolCallsAnchorMessageIds: new Set<string>(),
            items, listOrientation, platformOS: 'ios', rendererKind: 'flashList', sessionId: 'session-1',
            targetWindowState: inactiveWindow, transcriptNativeHotTailItemCount: 2, transcriptWebHotTailItemCount: 0,
            tailContiguousBoundary: { kind: 'messageIds', messageIds: ['tail-tool'] },
            resolveMessageIds: collectTranscriptNavigationMessageIdsForItem,
        });
        const canonicalIds = ['transcript-window-gap:tail:older', 'turn', 'tool-unit', 'tail-row'];
        expect(projection.listData.map((entry) => entry.id)).toEqual(listOrientation === 'inverted' ? [...canonicalIds].reverse() : canonicalIds);
        expect(projection.hotCold.active).toBe(false);
        expect(projection.indexMap.sourceIndexToRenderedIndex(0)).toBeNull();
        expect(items.map((entry) => entry.id)).toEqual(['old-row', 'turn', 'tool-unit', 'tail-row']);
    });

    it('composes entry slice, target window, orientation, and hot/cold carve into one projection', () => {
        const projection = project({
            entrySliceWindow: { anchorRowId: 'row-2', sessionId: 'session-1' },
            listOrientation: 'inverted',
            liveTailAnchorMessageId: 'msg-2',
            platformOS: 'ios',
            rendererKind: 'flashList',
            targetWindowState: {
                ...inactiveWindow,
                isWindowMode: true,
                targetSeq: 2,
                windowId: 'window-2',
                windowMaxSeq: 2,
                windowMinSeq: 1,
            },
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.entrySlice.withheldCount).toBe(4);
        expect(projection.targetWindow.display?.items.map((entry) => entry.id)).toEqual(['row-1', 'row-2']);
        expect(projection.displayItems.map((entry) => entry.id)).toEqual(['row-2', 'row-1']);
        expect(projection.listData.map((entry) => entry.id)).toEqual(['row-1']);
        expect(projection.hotCold.hotItemsCanonical.map((entry) => entry.id)).toEqual(['row-2']);
        expect(projection.nativeHotTailResetRequired).toBe(false);
        expect(projection.indexMap.renderedToSourceIndex(0)).toBe(0);
        expect(projection.indexMap.renderedToDisplayIndex(0)).toBe(1);
        expect(projection.indexMap.sourceIndexToDisplayIndex(0)).toBe(1);
        expect(projection.indexMap.sourceIndexToRenderedIndex(1)).toBeNull();
        expect(projection.indexMap.hotEdgeSourceIndices).toEqual([1]);
    });

    it('keeps every default-Legend row in one chronological renderer data projection', () => {
        const projection = project({
            liveTailAnchorMessageId: 'msg-5',
            platformOS: 'web',
            rendererKind: 'legendList',
            transcriptWebHotTailItemCount: 2,
        });

        expect(projection.listData.map((entry) => entry.id)).toEqual([
            'row-1',
            'row-2',
            'row-3',
            'row-4',
            'row-5',
            'row-6',
        ]);
        expect(projection.hotCold.active).toBe(false);
        expect(projection.hotCold.webFooterItems).toEqual([]);
        expect(projection.indexMap.resolveRendererTargetForDisplayIndex(4)).toEqual({
            kind: 'data',
            index: 4,
            itemId: 'row-5',
        });
    });

    it('projects FlashList hot-tail identities to explicit outside-data targets', () => {
        const standardProjection = project({
            liveTailAnchorMessageId: 'msg-5',
            platformOS: 'web',
            rendererKind: 'flashList',
            transcriptWebHotTailItemCount: 2,
        });

        expect(standardProjection.listData.map((entry) => entry.id)).toEqual([
            'row-1',
            'row-2',
            'row-3',
            'row-4',
        ]);
        expect(standardProjection.indexMap.resolveRendererTargetForDisplayIndex(4)).toEqual({
            fallbackIndex: 3,
            itemId: 'row-5',
            kind: 'outside-data',
            reason: 'renderer-edge',
            targetSeq: 5,
        });

        const invertedProjection = project({
            listOrientation: 'inverted',
            liveTailAnchorMessageId: 'msg-5',
            platformOS: 'ios',
            rendererKind: 'flashList',
            transcriptNativeHotTailItemCount: 2,
        });

        expect(invertedProjection.listData.map((entry) => entry.id)).toEqual([
            'row-4',
            'row-3',
            'row-2',
            'row-1',
        ]);
        expect(invertedProjection.indexMap.resolveRendererTargetForDisplayIndex(0)).toEqual({
            fallbackIndex: 0,
            itemId: 'row-6',
            kind: 'outside-data',
            reason: 'renderer-edge',
            targetSeq: 6,
        });
    });

    it('keeps loaded identities outside an active target window as materializable renderer targets', () => {
        const projection = project({
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 5,
                windowId: 'window-5',
                windowMaxSeq: 6,
                windowMinSeq: 5,
            },
        });

        expect(projection.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-5:older',
            'row-5',
            'row-6',
            'transcript-window-gap:window-5:newer',
        ]);
        expect(projection.listData[0]).toMatchObject({
            direction: 'older',
            kind: 'transcript-window-gap',
        });
        expect(projection.indexMap.renderedToSourceIndex(0)).toBeNull();
        expect(projection.indexMap.renderedToWindowContentIndex(0)).toBeNull();
        expect(projection.indexMap.renderedToWindowContentIndex(1)).toBe(0);
        expect(projection.indexMap.windowContentItemCount).toBe(2);
        expect(projection.indexMap.resolveRendererTargetForDisplayIndex(0)).toBeNull();
        expect(projection.indexMap.resolveRendererTargetForItemId(
            'transcript-window-gap:window-5:older',
        )).toBeNull();
        expect(projection.indexMap.resolveRendererTargetForItemId('row-2')).toEqual({
            fallbackIndex: 3,
            itemId: 'row-2',
            kind: 'outside-data',
            reason: 'projection-window',
            targetSeq: 2,
        });
    });

    it('keeps directional gap geometry truthful after native orientation projection', () => {
        const projection = project({
            listOrientation: 'inverted',
            platformOS: 'ios',
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 3,
                windowId: 'window-3',
                windowMaxSeq: 4,
                windowMinSeq: 2,
            },
        });

        expect(projection.canonicalWindowedItems.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-3:older',
            'row-2',
            'row-3',
            'row-4',
            'transcript-window-gap:window-3:newer',
        ]);
        expect(projection.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:window-3:newer',
            'row-4',
            'row-3',
            'row-2',
            'transcript-window-gap:window-3:older',
        ]);
    });

    it('composes target and tail gaps with projection-relative native edge facts in both orientations', () => {
        const standardProjection = project({
            platformOS: 'android',
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 3,
                windowId: 'window-3',
                windowMaxSeq: 4,
                windowMinSeq: 2,
            },
        });
        const standardFacts = createNativeStandardListFactSource({
            readContentHeight: () => 1_000,
            readLayoutHeight: () => 400,
            readRawScrollOffset: () => 0,
            readRenderedItemCount: () => standardProjection.listData.length,
            readRenderedVisibleRange: () => ({ startIndex: 0, endIndex: 1 }),
            readSourceIndexForRenderedIndex: standardProjection.indexMap.renderedToWindowContentIndex,
        });
        const standardRange = standardFacts.getVisibleSourceRange();
        expect(standardRange).toEqual({ firstSourceIndex: 0, lastSourceIndex: 0 });
        expect(resolveItemsToOlderEdge(
            standardRange,
            standardProjection.indexMap.windowContentItemCount,
        )).toBe(0);

        const invertedProjection = project({
            listOrientation: 'inverted',
            platformOS: 'ios',
            targetWindowState: {
                ...inactiveWindow,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                targetSeq: 3,
                windowId: 'window-3',
                windowMaxSeq: 4,
                windowMinSeq: 2,
            },
        });
        const invertedFacts = createNativeInvertedFlashListFactSource({
            readContentHeight: () => 1_000,
            readLayoutHeight: () => 400,
            readRawScrollOffset: () => 0,
            readRenderedItemCount: () => invertedProjection.listData.length,
            readRenderedVisibleRange: () => ({
                startIndex: invertedProjection.listData.length - 2,
                endIndex: invertedProjection.listData.length - 1,
            }),
            readSourceIndexForRenderedIndex: invertedProjection.indexMap.renderedToWindowContentIndex,
        });
        const invertedRange = invertedFacts.getVisibleSourceRange();
        expect(invertedRange).toEqual({ firstSourceIndex: 0, lastSourceIndex: 0 });
        expect(resolveItemsToOlderEdge(
            invertedRange,
            invertedProjection.indexMap.windowContentItemCount,
        )).toBe(0);

        const tailProjection = project({
            items: [item(401), item(410), item(1951), item(2000)],
            platformOS: 'android',
            tailContiguousBoundary: { kind: 'seq', seq: 1951 },
        });
        const tailFacts = createNativeStandardListFactSource({
            readContentHeight: () => 1_000,
            readLayoutHeight: () => 400,
            readRawScrollOffset: () => 0,
            readRenderedItemCount: () => tailProjection.listData.length,
            readRenderedVisibleRange: () => ({ startIndex: 1, endIndex: 2 }),
            readSourceIndexForRenderedIndex: tailProjection.indexMap.renderedToWindowContentIndex,
        });
        const tailRange = tailFacts.getVisibleSourceRange();
        expect(tailRange).toEqual({ firstSourceIndex: 0, lastSourceIndex: 1 });
        expect(resolveItemsToNewerEdge(
            tailRange,
            tailProjection.indexMap.windowContentItemCount,
        )).toBeNull();
    });

    it('keeps one stable tail-gap row until the discontinuity converges, then removes only the gap', () => {
        const open = project({
            items: [item(401), item(410), item(1951), item(2000)],
            tailContiguousBoundary: { kind: 'seq', seq: 1951 },
        });
        expect(open.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:tail:older',
            'row-1951',
            'row-2000',
        ]);

        const advanced = project({
            items: [item(401), item(410), item(1801), item(1951), item(2000)],
            tailContiguousBoundary: { kind: 'seq', seq: 1801 },
        });
        expect(advanced.listData.map((entry) => entry.id)).toEqual([
            'transcript-window-gap:tail:older',
            'row-1801',
            'row-1951',
            'row-2000',
        ]);

        const closed = project({
            items: [item(401), item(410), item(411), item(1801), item(1951), item(2000)],
            tailContiguousBoundary: null,
        });
        expect(closed.listData.map((entry) => entry.id)).toEqual([
            'row-401',
            'row-410',
            'row-411',
            'row-1801',
            'row-1951',
            'row-2000',
        ]);
    });

    it('reports native hot-tail reset as owner state instead of requiring render-phase ref mutation', () => {
        const projection = project({
            listOrientation: 'inverted',
            platformOS: 'ios',
            rendererKind: 'flashList',
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.hotCold.active).toBe(false);
        expect(projection.nativeHotTailResetRequired).toBe(true);
        expect(projection.listData.map((entry) => entry.id)).toEqual(['row-6', 'row-5', 'row-4', 'row-3', 'row-2', 'row-1']);
    });

    it('exposes native edge-slot rows as rendered content outside the recycler for blank classification', () => {
        const projection = project({
            listOrientation: 'inverted',
            liveTailAnchorMessageId: 'msg-5',
            platformOS: 'ios',
            rendererKind: 'flashList',
            transcriptNativeHotTailItemCount: 2,
        });

        expect(projection.hotCold.nativeEdgeSlotItems.map((entry) => entry.id)).toEqual(['row-5', 'row-6']);
        expect(projection.indexMap.hasRenderedContentOutsideRecycler).toBe(true);
        expect(projection.indexMap.hotEdgeSourceIndices).toEqual([4, 5]);
    });
});
