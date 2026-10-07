import * as React from 'react';
import { buildChatListItems, buildChatListItemsCached } from '@/components/sessions/chatListItems';
import { insertForkDividersIntoTranscriptItems, type ForkDividerTranscriptItem } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { sync } from '@/sync/sync';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    buildTranscriptTurnsCached,
    isTranscriptTurnsBuildCacheComplete,
    type TranscriptTurnsBuildCache,
} from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { ForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import {
    measureTranscriptDerivation,
} from '@/components/sessions/transcript/items/measureDerivation';
import {
    readTranscriptDerivedItemsCacheEntry,
    resolveTranscriptDerivedItemsCacheMaxSessions,
    writeTranscriptDerivedItemsCacheEntry,
} from '@/components/sessions/transcript/items/derivedItemsCache';

type BuildChatListItemsOptions = Parameters<typeof buildChatListItems>[0];

const TRANSCRIPT_COLD_MOUNT_TAIL_MESSAGE_COUNT = 96;
const TRANSCRIPT_COLD_MOUNT_BACKFILL_MESSAGE_COUNT = 256;

export function useTranscriptRootDerivedItems(params: Readonly<{
    actionDrafts: NonNullable<BuildChatListItemsOptions['actionDrafts']>;
    discardedPendingMessages: NonNullable<BuildChatListItemsOptions['discardedMessages']>;
    fork: ForkedTranscriptSnapshot | null;
    forkAwareMessageDescriptors: ForkAwareMessageDescriptors | null;
    forkedTranscriptEnabled: boolean;
    groupToolCalls: boolean;
    groupingMode: 'linear' | 'turns';
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    pendingMessages: BuildChatListItemsOptions['pendingMessages'];
    pendingUserActionRequests: NonNullable<BuildChatListItemsOptions['pendingUserActionRequests']>;
    sessionId: string;
    toolCallsGroupStrategy: 'all_tools_in_turn' | 'consecutive_tools';
}>) {
    const {
        actionDrafts,
        discardedPendingMessages,
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
        sessionId,
        toolCallsGroupStrategy,
    } = params;
    const syncTuning = sync.getSyncTuning();
    const derivedItemsCacheMaxSessions = resolveTranscriptDerivedItemsCacheMaxSessions(
        syncTuning.transcriptDerivedItemsCacheMaxSessions,
    );
    const transcriptMaxTurnEntriesPerListItem = syncTuning.transcriptMaxTurnEntriesPerListItem;
    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(
        sessionId,
        derivedItemsCacheMaxSessions,
    );
    const [localTurnsCacheEntry, setLocalTurnsCacheEntry] = React.useState<{
        sessionId: string;
        cache: TranscriptTurnsBuildCache;
    } | null>(null);
    const localTurnsCache = localTurnsCacheEntry?.sessionId === sessionId
        ? localTurnsCacheEntry.cache
        : null;
    const turnsCacheForBuild = localTurnsCache ?? derivedItemsCacheEntry.turnsCache;
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.turns', () => ({
            cacheProvided: turnsCacheForBuild ? 1 : 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
        }), () => {
            return buildTranscriptTurnsCached({
                cache: turnsCacheForBuild,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                groupToolCalls,
                toolCallsGroupStrategy,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
                tailWindowMessageCount: turnsCacheForBuild ? null : TRANSCRIPT_COLD_MOUNT_TAIL_MESSAGE_COUNT,
            });
        });
    }, [
        discardedPendingMessages,
        forkAwareMessageDescriptors,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        toolCallsGroupStrategy,
        turnsCacheForBuild,
    ]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, sessionId, turnsCache]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache || isTranscriptTurnsBuildCacheComplete(turnsCache)) return;

        let cancelled = false;
        let cancelScheduled: (() => void) | null = null;
        let currentCache = turnsCache;

        const scheduleNextBackfill = () => {
            cancelScheduled = runAfterInteractionsWithFallback(() => {
                cancelScheduled = null;
                if (cancelled) return;

                const nextCache = buildTranscriptTurnsCached({
                    cache: currentCache,
                    messageIdsOldestFirst,
                    messagesById,
                    pendingMessages,
                    discardedMessages: discardedPendingMessages,
                    groupToolCalls,
                    toolCallsGroupStrategy,
                    forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                    forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                    forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
                    backfillOlderMessageCount: TRANSCRIPT_COLD_MOUNT_BACKFILL_MESSAGE_COUNT,
                });
                currentCache = nextCache;
                writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
                    turnsCache: nextCache,
                });
                setLocalTurnsCacheEntry({ sessionId, cache: nextCache });

                if (!isTranscriptTurnsBuildCacheComplete(nextCache)) {
                    scheduleNextBackfill();
                }
            });
        };

        scheduleNextBackfill();

        return () => {
            cancelled = true;
            cancelScheduled?.();
        };
    }, [
        derivedItemsCacheMaxSessions,
        discardedPendingMessages,
        forkAwareMessageDescriptors,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        sessionId,
        toolCallsGroupStrategy,
        turnsCache,
    ]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            actionDraftCount: actionDrafts.length,
            cacheProvided: derivedItemsCacheEntry.linearItemsCache ? 1 : 0,
            discardedPendingCount: discardedPendingMessages?.length ?? 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            pendingCount: pendingMessages.length,
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            return buildChatListItemsCached({
                cache: derivedItemsCacheEntry.linearItemsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                groupConsecutiveToolCalls: groupToolCalls,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [
        actionDrafts,
        derivedItemsCacheEntry.linearItemsCache,
        discardedPendingMessages,
        forkAwareMessageDescriptors,
        groupToolCalls,
        groupingMode,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
    ]);

    React.useEffect(() => {
        if (groupingMode === 'turns' || !linearCache) return;
        writeTranscriptDerivedItemsCacheEntry(sessionId, derivedItemsCacheMaxSessions, {
            linearItemsCache: linearCache.cache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, linearCache, sessionId]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            actionDraftCount: actionDrafts.length,
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            if (groupingMode !== 'turns') {
                const base = linearCache?.items ?? buildChatListItems({
                    messageIdsOldestFirst,
                    messagesById,
                    pendingMessages,
                    discardedMessages: discardedPendingMessages,
                    pendingUserActionRequests,
                    actionDrafts,
                });
                if (!forkedTranscriptEnabled || !fork) return base;
                return insertForkDividersIntoTranscriptItems({ items: base, fork, sourceWindowComplete: true }) as ChatTranscriptListItem[];
            }

            const trailing = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                includeCommittedMessages: false,
            });

            const turns = turnsCache?.turns ?? [];
            const turnItems: ForkDividerTranscriptItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
            const base: ForkDividerTranscriptItem[] = [...turnItems, ...trailing];
            if (!forkedTranscriptEnabled || !fork) return base;
            return insertForkDividersIntoTranscriptItems({
                items: base,
                fork,
                sourceWindowComplete: turnsCache !== null && isTranscriptTurnsBuildCacheComplete(turnsCache),
            }) as ChatTranscriptListItem[];
        });
    }, [
        actionDrafts,
        discardedPendingMessages,
        fork,
        forkedTranscriptEnabled,
        groupingMode,
        linearCache,
        messageIdsOldestFirst,
        messagesById,
        pendingMessages,
        pendingUserActionRequests,
        turnsCache,
    ]);

    return {
        groupedItems,
        transcriptMaxTurnEntriesPerListItem,
    };
}
