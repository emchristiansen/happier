import {
    hasActivityAttention,
    resolveActivityAttentionSessionsFromRecords,
} from '@/activity/attention/activityAttentionSessions';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import {
    collectRecordIds,
    hasRecordValues,
} from '@/sync/store/sessionRecordProjection';
import {
    createRenderableRuntimeFreshnessLedger,
    createSessionRuntimeFreshnessLedger,
    createSessionSignatureLedger,
    isBeforeFreshnessBoundary,
} from '@/activity/attention/sessionAttentionSignatureLedger';


export type ActivityBadgeSessionOptions = Readonly<{
    showUnread: boolean;
    showPendingPermissionRequests: boolean;
    showPendingUserActionRequests: boolean;
    showQueuedUserInput: boolean;
}>;

export type LocalActivityBadgeSnapshot = Readonly<{
    count: number;
    hasLocalBadgeSource: boolean;
    isDataReady: boolean;
    showNonNumericDot: boolean;
}>;

export type LocalActivityBadgeSnapshotSelectorParams = Readonly<{
    badgesEnabled: boolean;
    friendRequestCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions: ActivityBadgeSessionOptions;
}>;

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const requests = value as Record<string, {
        createdAt?: unknown;
        kind?: unknown;
        tool?: unknown;
    }>;
    return collectRecordIds(requests).map((requestId) => {
        const request = requests[requestId];
        return [
            requestId,
            typeof request?.tool === 'string' ? request.tool : '',
            typeof request?.kind === 'string' ? request.kind : '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function readCompletedRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const completed = value as Record<string, { completedAt?: unknown; createdAt?: unknown }>;
    return collectRecordIds(completed).map((requestId) => {
        const request = completed[requestId];
        return [
            requestId,
            readNumber(request?.completedAt) ?? '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function buildParamsSignature(params: LocalActivityBadgeSnapshotSelectorParams): string {
    return [
        params.badgesEnabled === true ? 1 : 0,
        Math.max(0, Math.trunc(params.friendRequestCount)),
        params.hasNonNumericInboxAttention === true ? 1 : 0,
        params.sessionOptions.showUnread === false ? 0 : 1,
        params.sessionOptions.showPendingPermissionRequests === false ? 0 : 1,
        params.sessionOptions.showPendingUserActionRequests === false ? 0 : 1,
        params.sessionOptions.showQueuedUserInput === false ? 0 : 1,
    ].join('\u001f');
}

function buildSessionActivitySignature(session: Session): string {
    const metadata = session.metadata;
    const readState = metadata?.readStateV1;
    const agentState = session.agentState;
    return [
        session.id,
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.seq) ?? '',
        readNumber(session.updatedAt) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        metadata?.systemSessionV1?.hidden === true ? 1 : 0,
        readNumber(session.pendingCount) ?? '',
        readNumber(session.pendingBlockedCount) ?? '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join('\u001f');
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    const metadata = renderable.metadata;
    const readState = metadata?.readStateV1;
    return [
        renderable.id,
        readNumber(renderable.seq) ?? '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        metadata?.hiddenSystemSession === true ? 1 : 0,
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
        readNumber(renderable.pendingCount) ?? '',
        readNumber(renderable.pendingBlockedCount) ?? '',
    ].join('\u001f');
}

function buildSessionMessagesActivitySignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst.length,
    ].join('\u001f');
}

type BadgeSnapshotSourceIdentity = Readonly<{
    sessions: StorageState['sessions'];
    sessionListRenderables: StorageState['sessionListRenderables'];
    sessionMessages: StorageState['sessionMessages'];
    isDataReady: boolean;
    deltaRevision: number | null;
}>;

function isSameBadgeSnapshot(
    previous: LocalActivityBadgeSnapshot,
    next: LocalActivityBadgeSnapshot,
): boolean {
    return previous.count === next.count
        && previous.hasLocalBadgeSource === next.hasLocalBadgeSource
        && previous.isDataReady === next.isDataReady
        && previous.showNonNumericDot === next.showNonNumericDot;
}

export function createLocalActivityBadgeSnapshotSelector(
    params: LocalActivityBadgeSnapshotSelectorParams,
): (state: StorageState) => LocalActivityBadgeSnapshot {
    const paramsSignature = buildParamsSignature(params);
    const sessionLedger = createSessionSignatureLedger<Session>(buildSessionActivitySignature);
    const renderableLedger = createSessionSignatureLedger<SessionListRenderableSession>(
        buildRenderableActivitySignature,
    );
    const sessionMessagesLedger = createSessionSignatureLedger<StorageState['sessionMessages'][string] | undefined>(
        buildSessionMessagesActivitySignature,
    );
    const sessionFreshnessLedger = createSessionRuntimeFreshnessLedger();
    const renderableFreshnessLedger = createRenderableRuntimeFreshnessLedger();
    const attentionBySessionId = new Map<string, boolean>();
    // Whether `attentionBySessionId` holds every session. Only a full derivation
    // establishes that; until it has run once, an incremental update would be
    // applied to an empty cache and undercount.
    let hasSeededAttentionCache = false;
    let sessionAttentionCount = 0;
    let previousDeltaRevision: number | null = null;
    let previousSignature: string | null = null;
    let previousSnapshot: LocalActivityBadgeSnapshot | null = null;
    let previousSourceIdentity: BadgeSnapshotSourceIdentity | null = null;

    // The selector is the badge's subscription: React re-renders only when this
    // returns a different object. An evaluation that reaches the same badge values
    // must therefore return the *same* snapshot instance, not an equal one.
    // Every input that can move one session's attention is covered by exactly one
    // ledger, so the union of their change sets is the complete set of sessions
    // whose contribution can have moved this wave.
    const collectLedgerChangedSessionIds = (): readonly string[] => {
        const ids = new Set<string>();
        for (const id of sessionLedger.readChangedIds()) ids.add(id);
        for (const id of renderableLedger.readChangedIds()) ids.add(id);
        for (const id of sessionMessagesLedger.readChangedIds()) ids.add(id);
        for (const id of sessionFreshnessLedger.readChangedIds()) ids.add(id);
        for (const id of renderableFreshnessLedger.readChangedIds()) ids.add(id);
        return [...ids];
    };

    const commitSnapshot = (next: LocalActivityBadgeSnapshot): LocalActivityBadgeSnapshot => {
        if (previousSnapshot !== null && isSameBadgeSnapshot(previousSnapshot, next)) {
            return previousSnapshot;
        }
        previousSnapshot = next;
        return next;
    };

    const rebuildAttentionCache = (
        state: StorageState,
        nowMs: number,
    ): number => {
        hasSeededAttentionCache = true;
        attentionBySessionId.clear();
        let count = 0;
        const badgeSessions = resolveActivityAttentionSessionsFromRecords({
            sessionsById: state.sessions,
            sessionRowsById: state.sessionListRenderables,
        });
        for (const session of badgeSessions) {
            const hasAttention = hasActivityAttention(session, {
                ...params.sessionOptions,
                sessionMessagesById: state.sessionMessages,
                nowMs,
            });
            attentionBySessionId.set(session.id, hasAttention);
            if (hasAttention) count += 1;
        }
        sessionAttentionCount = count;
        return count;
    };

    const applyAttentionDelta = (
        state: StorageState,
        changedSessionIds: readonly string[],
        removedSessionIds: readonly string[],
        nowMs: number,
    ): number => {
        for (const sessionId of removedSessionIds) {
            if (attentionBySessionId.get(sessionId) === true) {
                sessionAttentionCount -= 1;
            }
            attentionBySessionId.delete(sessionId);
        }

        for (const sessionId of changedSessionIds) {
            const previousHasAttention = attentionBySessionId.get(sessionId) === true;
            const session = resolveActivityAttentionSessionsFromRecords({
                sessionsById: state.sessions[sessionId] ? { [sessionId]: state.sessions[sessionId] } : {},
                sessionRowsById: state.sessionListRenderables[sessionId]
                    ? { [sessionId]: state.sessionListRenderables[sessionId] }
                    : {},
            })[0];
            const nextHasAttention = session
                ? hasActivityAttention(session, {
                    ...params.sessionOptions,
                    sessionMessagesById: state.sessionMessages,
                    nowMs,
                })
                : false;
            if (previousHasAttention !== nextHasAttention) {
                sessionAttentionCount += nextHasAttention ? 1 : -1;
            }
            if (session) {
                attentionBySessionId.set(sessionId, nextHasAttention);
            } else {
                attentionBySessionId.delete(sessionId);
            }
        }

        return sessionAttentionCount;
    };

    return (state) => {
        const delta = state.sessionListRenderableDelta;
        const deltaRevision = delta?.revision ?? null;
        const nowMs = Date.now();
        // Runtime freshness is the one badge input that moves without the store
        // moving. Both reuse paths below are only sound while every recorded
        // freshness bit is still inside its window.
        const isFreshnessStable = isBeforeFreshnessBoundary(nowMs, [
            sessionFreshnessLedger.readNextBoundaryAtMs(),
            renderableFreshnessLedger.readNextBoundaryAtMs(),
        ]);
        // Store notifications that moved none of this badge's inputs cannot change
        // its snapshot, so they must cost O(1) rather than a derivation pass.
        // Runtime freshness is the one input that moves without the store moving,
        // so the reuse also has to stay inside the earliest freshness boundary the
        // ledgers recorded.
        if (
            previousSnapshot !== null
            && previousSourceIdentity !== null
            && previousSourceIdentity.sessions === state.sessions
            && previousSourceIdentity.sessionListRenderables === state.sessionListRenderables
            && previousSourceIdentity.sessionMessages === state.sessionMessages
            && previousSourceIdentity.isDataReady === state.isDataReady
            && previousSourceIdentity.deltaRevision === deltaRevision
            && isFreshnessStable
        ) {
            return previousSnapshot;
        }
        previousSourceIdentity = {
            sessions: state.sessions,
            sessionListRenderables: state.sessionListRenderables,
            sessionMessages: state.sessionMessages,
            isDataReady: state.isDataReady,
            deltaRevision,
        };

        const hasLocalBadgeSource =
            hasRecordValues(state.sessions)
            || hasRecordValues(state.sessionListRenderables)
            || params.friendRequestCount > 0
            || params.hasNonNumericInboxAttention === true;
        const canApplyDelta = params.badgesEnabled
            && isFreshnessStable
            && hasSeededAttentionCache
            && previousSnapshot
            && delta
            && previousDeltaRevision !== null
            && delta.revision !== previousDeltaRevision
            && delta.rebuiltSessionListViewData !== true;
        if (canApplyDelta) {
            const nextSessionAttentionCount = applyAttentionDelta(
                state,
                delta.changedSessionIds,
                delta.removedSessionIds,
                nowMs,
            );
            const count = Math.max(0, nextSessionAttentionCount + Math.max(0, Math.trunc(params.friendRequestCount)));
            previousDeltaRevision = delta.revision;
            previousSignature = [
                paramsSignature,
                state.isDataReady === true ? 1 : 0,
                hasLocalBadgeSource === true ? 1 : 0,
                delta.revision,
                count,
                params.hasNonNumericInboxAttention === true ? 1 : 0,
            ].join('\u001c');
            return commitSnapshot({
                count,
                hasLocalBadgeSource,
                isDataReady: state.isDataReady,
                showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
            });
        }
        const snapshotSignature = params.badgesEnabled
            ? [
                paramsSignature,
                state.isDataReady === true ? 1 : 0,
                hasLocalBadgeSource === true ? 1 : 0,
                sessionLedger.sync(state.sessions, (id) => state.sessions[id]),
                renderableLedger.sync(
                    state.sessionListRenderables,
                    (id) => state.sessionListRenderables[id],
                ),
                sessionMessagesLedger.sync(state.sessions, (id) => state.sessionMessages[id]),
                sessionFreshnessLedger.sync({
                    sessions: state.sessions,
                    sessionMessages: state.sessionMessages,
                    nowMs,
                    readSessionSignature: sessionLedger.readSignature,
                    readSessionMessagesSignature: sessionMessagesLedger.readSignature,
                }),
                renderableFreshnessLedger.sync(state.sessionListRenderables, nowMs),
            ].join('\u001c')
            : [
                paramsSignature,
                state.isDataReady === true ? 1 : 0,
                hasLocalBadgeSource === true ? 1 : 0,
            ].join('\u001c');

        if (previousSignature === snapshotSignature && previousSnapshot) {
            return previousSnapshot;
        }

        if (!params.badgesEnabled) {
            previousSignature = snapshotSignature;
            return commitSnapshot({
                count: 0,
                hasLocalBadgeSource,
                isDataReady: state.isDataReady,
                showNonNumericDot: false,
            });
        }

        // The ledgers just told us exactly which sessions moved, so only the very
        // first evaluation has to derive the whole account.
        const sessionAttentionCountForWave = hasSeededAttentionCache
            ? applyAttentionDelta(state, collectLedgerChangedSessionIds(), [], nowMs)
            : rebuildAttentionCache(state, nowMs);
        const count = Math.max(
            0,
            sessionAttentionCountForWave + Math.max(0, Math.trunc(params.friendRequestCount)),
        );

        previousSignature = snapshotSignature;
        previousDeltaRevision = deltaRevision;
        return commitSnapshot({
            count,
            hasLocalBadgeSource,
            isDataReady: state.isDataReady,
            showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
        });
    };
}
