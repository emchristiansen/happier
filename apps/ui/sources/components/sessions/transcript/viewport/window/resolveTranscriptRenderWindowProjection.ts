import {
    orientTranscriptListItems,
    resolveEntrySliceSourceBounds,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import type { SessionMessagesTailBoundary } from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import type { TranscriptLiveTailAnchorReason } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import { resolveTranscriptTargetWindowHostFacts } from './useTranscriptTargetWindowHostAdapter';
import type {
    TranscriptTargetWindowDisplayItem,
    TranscriptTargetWindowState,
    TranscriptWindowGapDescriptor,
} from './transcriptTargetWindowTypes';

type RenderWindowSegmentableItem = TranscriptTargetWindowDisplayItem & {
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
    turn?: {
        userMessageId?: string | null;
        content: readonly (
            | { kind: 'message'; messageId: string }
            | { kind: 'tool_calls'; toolMessageIds: readonly string[] }
            | { kind: string }
        )[];
    };
};

export type TranscriptRendererDataTarget =
    | Readonly<{
        kind: 'data';
        index: number;
        itemId: string;
    }>
    | Readonly<{
        kind: 'outside-data';
        fallbackIndex: number | null;
        itemId: string;
        reason: 'projection-window' | 'renderer-edge';
        targetSeq: number | null;
    }>;

export type TranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem> = Readonly<{
    canonicalWindowedItems: readonly TItem[];
    displayItems: readonly TItem[];
    entrySlice: Readonly<{
        bounds: Readonly<{ start: number; end: number }> | null;
        items: readonly TItem[];
        withheldCount: number;
    }>;
    hotCold: Readonly<{
        active: boolean;
        coldCount: number;
        coldItems: readonly TItem[];
        hotCount: number;
        hotItems: readonly TItem[];
        hotItemsCanonical: readonly TItem[];
        nativeEdgeSlotItems: readonly TItem[];
        splitIndex: number;
        webFooterItems: readonly TItem[];
    }>;
    indexMap: Readonly<{
        displayIndexToSourceIndex: (displayIndex: number) => number | null;
        hasRenderedContentOutsideRecycler: boolean;
        hotEdgeSourceIndices: readonly number[];
        renderedToDisplayIndex: (renderedIndex: number) => number | null;
        renderedToSourceIndex: (renderedIndex: number) => number | null;
        renderedToWindowContentIndex: (renderedIndex: number) => number | null;
        resolveRendererTargetForDisplayIndex: (displayIndex: number) => TranscriptRendererDataTarget | null;
        resolveRendererTargetForItemId: (itemId: string) => TranscriptRendererDataTarget | null;
        sourceIndexToDisplayIndex: (sourceIndex: number) => number | null;
        sourceIndexToRenderedIndex: (sourceIndex: number) => number | null;
        windowContentItemCount: number;
    }>;
    listData: readonly TItem[];
    liveTailAnchor: Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    nativeHotTailResetRequired: boolean;
    targetWindow: ReturnType<typeof resolveTranscriptTargetWindowHostFacts<TItem>>;
}>;

export function resolveTranscriptRenderWindowProjection<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    activeThinkingMessageId: string | null;
    createWindowGapItem: (gap: TranscriptWindowGapDescriptor) => TItem;
    entrySliceWindow: Readonly<{ anchorRowId: string; sessionId: string }> | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    isSeqLoaded?: (seq: number) => boolean;
    isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
    items: readonly TItem[];
    listOrientation: TranscriptListOrientation;
    liveTailAnchorMessageId?: string | null;
    platformOS: string;
    rendererKind: 'flashList' | 'legendList';
    resolveSeq?: (item: TItem) => number | null | undefined;
    resolveLiveTailAnchor?: (items: readonly TItem[]) => Readonly<{ messageId: string; reason?: TranscriptLiveTailAnchorReason | null }> | null;
    sessionId: string;
    tailContiguousBoundary?: SessionMessagesTailBoundary | null;
    resolveMessageIds?: (item: TItem) => readonly string[];
    targetWindowState: TranscriptTargetWindowState;
    transcriptNativeHotTailItemCount: number;
    transcriptWebHotTailItemCount: number;
}>): TranscriptRenderWindowProjection<TItem> {
    const entrySliceBounds = resolveActiveEntrySliceBounds({
        entrySliceWindow: params.entrySliceWindow,
        items: params.items,
        orientation: params.listOrientation,
        platformOS: params.platformOS,
        sessionId: params.sessionId,
    });
    const entrySliceItems = entrySliceBounds
        ? params.items.slice(entrySliceBounds.start, entrySliceBounds.end)
        : params.items;
    const entrySliceWithheldCount = entrySliceBounds
        ? params.items.length - (entrySliceBounds.end - entrySliceBounds.start)
        : 0;

    const targetWindow = resolveTranscriptTargetWindowHostFacts({
        items: entrySliceItems,
        isSeqLoaded: params.isSeqLoaded,
        isSeqRangeLoaded: params.isSeqRangeLoaded,
        resolveSeq: params.resolveSeq,
        tailContiguousBoundary: params.tailContiguousBoundary ?? null,
        resolveMessageIds: params.resolveMessageIds,
        windowState: params.targetWindowState,
    });
    const canonicalWindowedItems = [
        ...(targetWindow.gaps.older ? [params.createWindowGapItem(targetWindow.gaps.older)] : []),
        ...targetWindow.items,
        ...(targetWindow.gaps.newer ? [params.createWindowGapItem(targetWindow.gaps.newer)] : []),
    ];
    const displayItems = orientTranscriptListItems(canonicalWindowedItems, params.listOrientation);
    const liveTailAnchor = params.resolveLiveTailAnchor?.(canonicalWindowedItems) ?? null;
    const liveTailAnchorMessageId = liveTailAnchor?.messageId ?? params.liveTailAnchorMessageId ?? null;

    const platformIsWeb = params.platformOS === 'web';
    const hotTailItemCount = platformIsWeb
        ? params.transcriptWebHotTailItemCount
        : params.transcriptNativeHotTailItemCount;
    // Legend owns one chronological recycler data projection. Splitting live rows into an edge
    // slot/footer would put visible identities outside Legend MVCP and recreate the zero-cold
    // first-page ownership gap. The hot/cold carve is now strictly FlashList compatibility.
    // A gap is a first-class pagination boundary. Keeping it in the recycler is
    // what lets the existing reached-threshold geometry prefetch before the
    // boundary becomes visible; carving it into a FlashList edge slot would
    // split display and pagination truth.
    const hasWindowGap = targetWindow.gaps.older !== null || targetWindow.gaps.newer !== null;
    const hotColdEnabled =
        !hasWindowGap &&
        params.rendererKind === 'flashList' &&
        (platformIsWeb || hotTailItemCount > 0);
    const rawSegments = buildTranscriptHotColdSegments({
        activeThinkingMessageId: params.activeThinkingMessageId,
        enabled: hotColdEnabled,
        expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
        hotTailItemCount: hotTailItemCount > 0 ? hotTailItemCount : 1,
        items: canonicalWindowedItems,
        liveTailAnchorMessageId,
        liveTailOnly: !platformIsWeb,
        maxHotTailItems: platformIsWeb ? undefined : (hotTailItemCount > 0 ? hotTailItemCount : 1),
    });
    const coldItems = orientTranscriptListItems(rawSegments.coldItems, params.listOrientation);
    const hotItems = orientTranscriptListItems(rawSegments.hotItems, params.listOrientation);
    const hotColdActive = rawSegments.hotItems.length > 0;
    const listData = hotColdActive ? coldItems : displayItems;
    const sourceIndexById = buildSourceIndexById(params.items);
    const displaySourceIndices = displayItems.map((item) => sourceIndexById.get(item.id) ?? null);
    const renderedSourceIndices = listData.map((item) => sourceIndexById.get(item.id) ?? null);
    const windowContentIndexById = new Map<string, number>();
    targetWindow.items.forEach((item, index) => {
        if (!windowContentIndexById.has(item.id)) windowContentIndexById.set(item.id, index);
    });
    const renderedWindowContentIndices = listData.map((item) => windowContentIndexById.get(item.id) ?? null);
    const hotEdgeSourceIndices = !platformIsWeb && hotColdActive
        ? rawSegments.hotItems
            .map((item) => sourceIndexById.get(item.id) ?? null)
            .filter((index): index is number => index !== null)
        : [];
    const sourceToDisplayIndex = new Map<number, number>();
    displaySourceIndices.forEach((sourceIndex, displayIndex) => {
        if (sourceIndex !== null && !sourceToDisplayIndex.has(sourceIndex)) {
            sourceToDisplayIndex.set(sourceIndex, displayIndex);
        }
    });
    const sourceToRenderedIndex = new Map<number, number>();
    renderedSourceIndices.forEach((sourceIndex, renderedIndex) => {
        if (sourceIndex !== null && !sourceToRenderedIndex.has(sourceIndex)) {
            sourceToRenderedIndex.set(sourceIndex, renderedIndex);
        }
    });
    const renderedIndexById = new Map<string, number>();
    listData.forEach((item, renderedIndex) => {
        if (!renderedIndexById.has(item.id)) renderedIndexById.set(item.id, renderedIndex);
    });
    const sourceItemById = new Map<string, TItem>();
    for (const item of params.items) {
        if (!sourceItemById.has(item.id)) sourceItemById.set(item.id, item);
    }
    const displayItemIds = new Set(displayItems.map((item) => item.id));
    const outsideDataFallbackIndex = listData.length <= 0
        ? null
        : params.listOrientation === 'inverted'
            ? 0
            : listData.length - 1;
    const resolveRendererTargetForItemId = (itemId: string): TranscriptRendererDataTarget | null => {
        const sourceItem = sourceItemById.get(itemId);
        // Synthetic recycler rows (for example a gap marker) participate in
        // geometry only; they are never navigation/restore targets.
        if (!sourceItem) return null;
        const renderedIndex = renderedIndexById.get(itemId);
        if (renderedIndex !== undefined) {
            return { kind: 'data', index: renderedIndex, itemId };
        }
        const rawTargetSeq = params.resolveSeq ? params.resolveSeq(sourceItem) : sourceItem.seq;
        const targetSeq = typeof rawTargetSeq === 'number' && Number.isFinite(rawTargetSeq) && rawTargetSeq >= 0
            ? Math.trunc(rawTargetSeq)
            : null;
        return {
            kind: 'outside-data',
            fallbackIndex: outsideDataFallbackIndex,
            itemId,
            reason: displayItemIds.has(itemId) ? 'renderer-edge' : 'projection-window',
            targetSeq,
        };
    };

    return {
        canonicalWindowedItems,
        displayItems,
        entrySlice: {
            bounds: entrySliceBounds,
            items: entrySliceItems,
            withheldCount: entrySliceWithheldCount,
        },
        hotCold: {
            active: hotColdActive,
            coldCount: rawSegments.coldItems.length,
            coldItems,
            hotCount: rawSegments.hotItems.length,
            hotItems,
            hotItemsCanonical: rawSegments.hotItems,
            nativeEdgeSlotItems: !platformIsWeb && hotColdActive ? rawSegments.hotItems : [],
            splitIndex: rawSegments.splitIndex,
            webFooterItems: platformIsWeb && hotColdActive ? hotItems : [],
        },
        indexMap: {
            displayIndexToSourceIndex: (displayIndex) => readIndex(displaySourceIndices, displayIndex),
            hasRenderedContentOutsideRecycler: hotEdgeSourceIndices.length > 0,
            hotEdgeSourceIndices,
            renderedToDisplayIndex: (renderedIndex) => {
                const sourceIndex = readIndex(renderedSourceIndices, renderedIndex);
                return sourceIndex === null ? null : sourceToDisplayIndex.get(sourceIndex) ?? null;
            },
            renderedToSourceIndex: (renderedIndex) => readIndex(renderedSourceIndices, renderedIndex),
            renderedToWindowContentIndex: (renderedIndex) => readIndex(renderedWindowContentIndices, renderedIndex),
            resolveRendererTargetForDisplayIndex: (displayIndex) => {
                const normalized = Number.isInteger(displayIndex) ? displayIndex : -1;
                const item = normalized >= 0 ? displayItems[normalized] : undefined;
                return item ? resolveRendererTargetForItemId(item.id) : null;
            },
            resolveRendererTargetForItemId,
            sourceIndexToDisplayIndex: (sourceIndex) => sourceToDisplayIndex.get(sourceIndex) ?? null,
            sourceIndexToRenderedIndex: (sourceIndex) => sourceToRenderedIndex.get(sourceIndex) ?? null,
            windowContentItemCount: targetWindow.items.length,
        },
        listData,
        liveTailAnchor,
        nativeHotTailResetRequired: params.platformOS !== 'web' && !hotColdActive,
        targetWindow,
    };
}

function resolveActiveEntrySliceBounds<TItem extends RenderWindowSegmentableItem>(params: Readonly<{
    entrySliceWindow: Readonly<{ anchorRowId: string; sessionId: string }> | null;
    items: readonly TItem[];
    orientation: TranscriptListOrientation;
    platformOS: string;
    sessionId: string;
}>): Readonly<{ start: number; end: number }> | null {
    if (params.platformOS === 'web') return null;
    if (!params.entrySliceWindow || params.entrySliceWindow.sessionId !== params.sessionId) return null;
    const anchorSourceIndex = params.items.findIndex((item) => item.id === params.entrySliceWindow?.anchorRowId);
    if (anchorSourceIndex < 0) return null;
    const bounds = resolveEntrySliceSourceBounds({
        anchorSourceIndex,
        count: params.items.length,
        orientation: params.orientation,
    });
    return bounds.end - bounds.start < params.items.length ? bounds : null;
}

function buildSourceIndexById<TItem extends { id: string }>(items: readonly TItem[]): Map<string, number> {
    const byId = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item && !byId.has(item.id)) byId.set(item.id, index);
    }
    return byId;
}

function readIndex(indices: readonly (number | null)[], index: number): number | null {
    const normalized = Number.isInteger(index) ? index : -1;
    if (normalized < 0 || normalized >= indices.length) return null;
    return indices[normalized] ?? null;
}
