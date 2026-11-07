import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import { createReducer } from '@/sync/reducer/reducer';
import { buildPendingChangedSessionPatch } from '@/sync/engine/socket/pendingChangedSessionPatch';
import { planSessionListRenderablePatches, planSessionListRenderableReplacement } from '@/sync/store/domains/sessionListRenderableStoreUpdate';
import { buildNextSessionListRenderableDelta } from '@/sync/store/domains/sessionListRenderableCommit';

import { createLocalActivityBadgeSnapshotSelector } from './createLocalActivityBadgeSnapshotSelector';

const SELECTOR_PARAMS = {
    badgesEnabled: true,
    friendRequestCount: 0,
    hasNonNumericInboxAttention: false,
    sessionOptions: {
        showUnread: true,
        showPendingPermissionRequests: true,
        showPendingUserActionRequests: true,
        showQueuedUserInput: true,
    },
} as const;

const RENDERABLE_COUNT = 40;

/**
 * `thinkingAt` is read by both renderable signature builders, so counting reads
 * of it measures how many renderables the selector actually re-derives on a
 * wave. Reading it is the derivation; a wave that touches one session must not
 * pay for the whole account.
 */
function createTrackedRenderable(
    id: string,
    hasUnreadMessages: boolean,
    onFieldRead: (id: string) => void,
): SessionListRenderableSession {
    const renderable = {
        id,
        seq: 2,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        lastViewedSessionSeq: hasUnreadMessages ? 1 : 2,
        hasUnreadMessages,
    } as unknown as SessionListRenderableSession;
    Object.defineProperty(renderable, 'thinkingAt', {
        configurable: true,
        enumerable: true,
        get: () => {
            onFieldRead(id);
            return 0;
        },
    });
    return renderable;
}

function createSessionMessages(messagesVersion: number): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion,
        isLoaded: true,
    };
}

function createState(params: Readonly<{
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionMessages?: Record<string, SessionMessages>;
    delta: StorageState['sessionListRenderableDelta'];
}>): StorageState {
    return {
        sessions: {},
        sessionListRenderables: params.sessionListRenderables,
        sessionMessages: params.sessionMessages ?? {},
        isDataReady: true,
        sessionListRenderableDelta: params.delta,
    } as unknown as StorageState;
}

describe('createLocalActivityBadgeSnapshotSelector derivation scope', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([[0, 0], [1, 1], [0, 1], [1, 0]])('reconciles a pending delta with a full refresh (%s -> %s)', (initialCount, finalCount) => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const selector = createLocalActivityBadgeSnapshotSelector(SELECTOR_PARAMS);
        const row = { ...createTrackedRenderable('row-a', false, () => {}),
            pendingCount: initialCount, pendingVersion: 0 };
        const initial = createState({ sessionListRenderables: { 'row-a': row },
            delta: { revision: 1, changedSessionIds: ['row-a'], removedSessionIds: [], rebuiltSessionListViewData: true } });
        expect(selector(initial).count).toBe(initialCount);

        const changed = planSessionListRenderablePatches({
            previousRenderables: initial.sessionListRenderables,
            patches: [{ sessionId: 'row-a', patch: buildPendingChangedSessionPatch({
                pendingCount: 1 - initialCount, pendingVersion: 1,
            }) }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });
        expect(changed.needsSessionListViewDataRebuild).toBe(false);
        const delta = buildNextSessionListRenderableDelta({ previous: initial.sessionListRenderableDelta,
            changedSessionIds: changed.changedSessionIds, removedSessionIds: changed.removedSessionIds,
            rebuiltSessionListViewData: changed.needsSessionListViewDataRebuild });
        expect(selector(createState({ sessionListRenderables: changed.nextRenderables, delta })).count).toBe(1 - initialCount);

        const refreshed = planSessionListRenderableReplacement({ previousRenderables: changed.nextRenderables,
            incomingRenderables: [{ ...row, pendingCount: finalCount, pendingVersion: 2 }, createTrackedRenderable('row-b', false, () => {})],
            isSessionListViewDataUninitialized: false, rebuildOnAttentionPromotionFieldsChange: false });
        expect(refreshed.needsSessionListViewDataRebuild).toBe(true);
        const finalState = createState({ sessionListRenderables: refreshed.nextRenderables,
            delta: buildNextSessionListRenderableDelta({ previous: delta, changedSessionIds: refreshed.changedSessionIds,
                removedSessionIds: refreshed.removedSessionIds, rebuiltSessionListViewData: refreshed.needsSessionListViewDataRebuild }) });
        expect(createLocalActivityBadgeSnapshotSelector(SELECTOR_PARAMS)(finalState).count).toBe(finalCount);
        expect(selector(finalState).count).toBe(finalCount);
    });

    it('does not re-derive every renderable when only one session transcript advances', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const reads: string[] = [];
        const renderables: Record<string, SessionListRenderableSession> = {};
        for (let index = 0; index < RENDERABLE_COUNT; index += 1) {
            const id = `row-${index}`;
            renderables[id] = createTrackedRenderable(id, index === 0, (readId) => reads.push(readId));
        }
        const selector = createLocalActivityBadgeSnapshotSelector(SELECTOR_PARAMS);
        const delta = {
            revision: 1,
            changedSessionIds: Object.keys(renderables),
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        } as const;

        expect(selector(createState({
            sessionListRenderables: renderables,
            sessionMessages: { 'row-0': createSessionMessages(1) },
            delta,
        })).count).toBe(1);
        expect(reads.length).toBeGreaterThan(0);

        // A streaming message replaces the sessionMessages record without moving
        // the session-list delta. Nothing about the other 39 rows changed.
        reads.length = 0;
        expect(selector(createState({
            sessionListRenderables: renderables,
            sessionMessages: { 'row-0': createSessionMessages(2) },
            delta,
        })).count).toBe(1);

        const unrelatedReads = reads.filter((id) => id !== 'row-0');
        expect(unrelatedReads).toEqual([]);
    });

    it('still reports the badge when an unrelated renderable becomes unread', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
        const renderables: Record<string, SessionListRenderableSession> = {};
        for (let index = 0; index < RENDERABLE_COUNT; index += 1) {
            const id = `row-${index}`;
            renderables[id] = createTrackedRenderable(id, false, () => {});
        }
        const selector = createLocalActivityBadgeSnapshotSelector(SELECTOR_PARAMS);

        expect(selector(createState({
            sessionListRenderables: renderables,
            delta: {
                revision: 1,
                changedSessionIds: Object.keys(renderables),
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        })).count).toBe(0);

        const nextRenderables = {
            ...renderables,
            'row-7': createTrackedRenderable('row-7', true, () => {}),
        };
        expect(selector(createState({
            sessionListRenderables: nextRenderables,
            delta: {
                revision: 2,
                changedSessionIds: ['row-7'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        })).count).toBe(1);
    });

    it('keeps live pending attention without an input change past the runtime staleness window', () => {
        const observedAtMs = 1_000_000;
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(observedAtMs);
        const renderable = {
            id: 'pending-row',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: observedAtMs,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            metadata: null,
            metadataVersion: 0,
            agentStateVersion: 0,
            lastViewedSessionSeq: 1,
            hasUnreadMessages: false,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: observedAtMs,
        } as unknown as SessionListRenderableSession;
        const selector = createLocalActivityBadgeSnapshotSelector(SELECTOR_PARAMS);
        const delta = {
            revision: 1,
            changedSessionIds: ['pending-row'],
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        } as const;

        expect(selector(createState({
            sessionListRenderables: { 'pending-row': renderable },
            delta,
        })).count).toBe(1);

        dateNow.mockReturnValue(observedAtMs + 10 * 60_000);

        expect(selector(createState({
            sessionListRenderables: { 'pending-row': renderable },
            sessionMessages: { other: createSessionMessages(1) },
            delta,
        })).count).toBe(1);
    });
});
