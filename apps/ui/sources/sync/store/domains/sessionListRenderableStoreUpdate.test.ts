import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { projectSessionListPlacement } from '../../domains/session/listing/placement/sessionListPlacementProjection';
import {
    planSessionListRenderableMerge,
    planSessionListRenderablePatches,
    planSessionListRenderableReplacement,
    resolveSessionListRenderableRemovalWindow,
} from './sessionListRenderableStoreUpdate';

function makeRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('sessionListRenderableStoreUpdate', () => {
    it.each(['merge', 'patch'] as const)('keeps newer pending flags through an older %s projection', (kind) => {
        const previous = makeRenderable('s1', {
            active: true,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 200,
        });
        const older = {
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: 100,
        };
        const plan = kind === 'merge'
            ? planSessionListRenderableMerge({
                previousRenderables: { s1: previous },
                incomingRenderables: [{ ...previous, ...older }],
                isSessionListViewDataUninitialized: false,
            })
            : planSessionListRenderablePatches({
                previousRenderables: { s1: previous },
                patches: [{ sessionId: 's1', patch: older }],
                isSessionListViewDataUninitialized: false,
            });
        expect(plan.nextRenderables.s1.hasPendingPermissionRequests).toBe(false);
        expect(plan.nextRenderables.s1.hasPendingUserActionRequests).toBe(false);
        expect(plan.nextRenderables.s1.pendingRequestObservedAt).toBe(200);
        expect(plan.noop).toBe(true);
    });

    it('merges incoming renderables without removing existing rows omitted from an append page', () => {
        const previous = makeRenderable('s_existing', { createdAt: 10 });
        const appended = makeRenderable('s_appended', { createdAt: 5 });
        const plan = planSessionListRenderableMerge({
            previousRenderables: { s_existing: previous },
            incomingRenderables: [appended],
            isSessionListViewDataUninitialized: false,
        });

        expect(plan.nextRenderables.s_existing).toBe(previous);
        expect(plan.nextRenderables.s_appended).toEqual(expect.objectContaining({
            id: appended.id,
            createdAt: appended.createdAt,
        }));
        expect(plan.changedCount).toBe(1);
        expect(plan.removedCount).toBe(0);
        expect(plan.needsSessionListViewDataRebuild).toBe(true);
    });

    it('keeps merge no-op when an append page only repeats existing equivalent renderables', () => {
        const previous = makeRenderable('s_existing', { createdAt: 10 });
        const plan = planSessionListRenderableMerge({
            previousRenderables: { s_existing: previous },
            incomingRenderables: [{ ...previous, metadata: previous.metadata ? { ...previous.metadata } : null }],
            isSessionListViewDataUninitialized: false,
        });

        expect(plan.nextRenderables.s_existing).toBe(previous);
        expect(plan.noop).toBe(true);
        expect(plan.changedCount).toBe(0);
        expect(plan.removedCount).toBe(0);
        expect(plan.needsSessionListViewDataRebuild).toBe(false);
    });

    it('does not rebuild list data for attention-only replacement changes when attention promotion is disabled', () => {
        const previous = makeRenderable('s1', { latestReadyEventSeq: null });
        const plan = planSessionListRenderableReplacement({
            previousRenderables: { s1: previous },
            incomingRenderables: [{ ...previous, latestReadyEventSeq: 4 }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('rebuilds list data for attention-only replacement changes when attention promotion is enabled', () => {
        const previous = makeRenderable('s1', { latestReadyEventSeq: null });
        const plan = planSessionListRenderableReplacement({
            previousRenderables: { s1: previous },
            incomingRenderables: [{ ...previous, latestReadyEventSeq: 4 }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('rebuilds list data for attention-only patch changes when attention promotion is enabled', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: now - 1_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{ sessionId: 's1', patch: { hasPendingUserActionRequests: true } }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('rebuilds list data when a manual unread patch enters attention placement', () => {
        const previous = makeRenderable('s1', {
            seq: 742,
            lastViewedSessionSeq: 742,
            latestReadyEventSeq: 110,
            hasUnreadMessages: false,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    lastViewedSessionSeq: 738,
                    hasUnreadMessages: true,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('does not rebuild list data for heartbeat-only thinking freshness changes while promotion state is unchanged', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: now - 1_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{ sessionId: 's1', patch: { thinkingAt: now - 500 } }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.attentionPromotionFieldChangeCount).toBe(0);
    });

    it('routes working-signal refreshes to the row-refresh channel instead of a structural rebuild', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 60_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    latestTurnStatusObservedAt: now,
                    activeAt: now,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        // Placement is 'working' before and after, so no rebuild — but the
        // extended working window must reach the committed view data or the
        // UI later demotes the session at the STALE freshness expiry.
        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toContain('s1');
    });

    it('routes working-signal refreshes through the merge plan path to the row-refresh channel', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 60_000,
        });
        const plan = planSessionListRenderableMerge({
            previousRenderables: { s1: previous },
            incomingRenderables: [{
                ...previous,
                latestTurnStatusObservedAt: now,
                activeAt: now,
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toContain('s1');
    });

    it('routes retention-input refreshes on retainable working candidates to the row-refresh channel', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 600_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{ sessionId: 's1', patch: { activeAt: now - 90_000 } }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toContain('s1');
    });

    it('rebuilds list data when a stale retained working candidate becomes terminal', () => {
        const now = Date.now();
        const previous = makeRenderable('s1', {
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 600_000,
            activeAt: now - 600_000,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: true,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(plan.attentionPromotionFieldChangeCount).toBe(1);
    });

    it('defers warm-cache persistence for active heartbeat progress patches', () => {
        const previous = makeRenderable('s1', {
            active: true,
            activeAt: 100,
            updatedAt: 100,
            presence: 'online',
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    activeAt: 200,
                    updatedAt: 200,
                    presence: 'online',
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
        expect(plan.didImmediateWarmCacheRelevantRenderableChange).toBe(false);
        expect(plan.didDeferredWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('marks latest turn projection patches as warm-cache relevant', () => {
        const previous = makeRenderable('s1', {
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
            rollbackEligibleTurnStarts: [1],
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 200,
                    rollbackEligibleTurnStarts: [1, 3],
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('marks session read-model patches as warm-cache relevant', () => {
        const previous = makeRenderable('s1', {
            seq: 10,
            lastViewedSessionSeq: 8,
            latestReadyEventSeq: 9,
            latestReadyEventAt: 100,
            hasUnreadMessages: true,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    seq: 11,
                    lastViewedSessionSeq: 10,
                    latestReadyEventSeq: 11,
                    latestReadyEventAt: 200,
                    hasUnreadMessages: false,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.didWarmCacheRelevantRenderableChange).toBe(true);
    });

    it('treats pending, unread, and request row updates as overlay-only when placement does not change', () => {
        const previous = makeRenderable('s1', {
            pendingCount: 0,
            pendingBlockedCount: 0,
            hasUnreadMessages: false,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: null,
        });
        const plan = planSessionListRenderablePatches({
            previousRenderables: { s1: previous },
            patches: [{
                sessionId: 's1',
                patch: {
                    pendingCount: 2,
                    pendingBlockedCount: 1,
                    hasUnreadMessages: true,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: 200,
                },
            }],
            isSessionListViewDataUninitialized: false,
            rebuildOnAttentionPromotionFieldsChange: false,
        });

        expect(plan.changedCount).toBe(1);
        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toEqual([]);
        expect(plan.nextRenderables.s1.pendingBlockedCount).toBe(1);
        expect(plan.nextRenderables.s1.hasPendingUserActionRequests).toBe(true);
    });

    /**
     * **A session that is already unread must not churn when more messages arrive.**
     *
     * Unread membership is a boolean edge, so while it stays true it is the same fact and must cost
     * nothing: no attention/placement recompute, no view-data rebuild, no row refresh, no eager
     * warm-cache write. The row's *activity* is a different fact — `seq` and `meaningfulActivityAt`
     * legitimately move on every message and the row legitimately reorders — so this pair separates
     * the two rather than asserting that nothing at all changed.
     *
     * The separation is what makes it discriminating. `unreadSince` is the attention lane's ordering
     * key; the moment the unread fact is recomputed per message (the entry instant re-stamped from
     * the latest activity, or the lane ordered by activity time instead of the entry instant) the
     * placement timestamp moves with every message and the first test fails on the rebuild and
     * attention counters. The second test holds the same activity delta fixed and moves only the
     * read cursor, so the counters are proven to be reachable rather than stuck at zero.
     */
    describe('repeat unread activity', () => {
        const UNREAD_SINCE = 4_000;
        /** Everything a further message moves, and nothing else. */
        const FURTHER_MESSAGE_PATCH = {
            seq: 11,
            updatedAt: 9_000,
            activeAt: 9_000,
            meaningfulActivityAt: 9_000,
            hasUnreadMessages: true,
            // An incoming row built from a server that has no entry instant for this session: the
            // hostile shape, because it is the one a per-message re-stamp would fill from activity.
            unreadSince: null,
        } as const;

        function makeUnreadRow(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
            return makeRenderable('s_unread', {
                active: true,
                presence: 'online',
                // No terminal turn status and no ready event: this row's attention reason is generic
                // unread, which is the lane under test. A `completed` status would project to the
                // 'ready' lane instead and every assertion below would hold vacuously.
                latestTurnStatus: null,
                latestReadyEventSeq: null,
                seq: 10,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: true,
                unreadSince: UNREAD_SINCE,
                createdAt: 1_000,
                updatedAt: UNREAD_SINCE,
                activeAt: UNREAD_SINCE,
                meaningfulActivityAt: UNREAD_SINCE,
                ...overrides,
            });
        }

        it('costs no attention, rebuild, row-refresh or eager persist while the session merely stays unread', () => {
            const previous = makeUnreadRow();
            // Fixture guard: the row must really be in the generic unread lane, or the assertions
            // below hold for a reason that has nothing to do with the unread fact.
            expect(projectSessionListPlacement({ session: previous, nowMs: 10_000 }).kind).toBe('unread');

            const plan = planSessionListRenderablePatches({
                previousRenderables: { s_unread: previous },
                patches: [{ sessionId: 's_unread', patch: { ...FURTHER_MESSAGE_PATCH } }],
                isSessionListViewDataUninitialized: false,
                rebuildOnAttentionPromotionFieldsChange: true,
            });
            expect(projectSessionListPlacement({ session: plan.nextRenderables.s_unread, nowMs: 10_000 }).kind).toBe('unread');

            // The unread fact contributes nothing, because its entry instant is frozen while
            // membership holds — so the attention lane neither re-sorts nor re-renders.
            expect(plan.nextRenderables.s_unread.unreadSince).toBe(UNREAD_SINCE);
            expect(plan.attentionPromotionFieldChangeCount).toBe(0);
            expect(plan.needsSessionListViewDataRebuild).toBe(false);
            expect(plan.listViewFieldChangeCount).toBe(0);
            expect(plan.listViewRowRefreshSessionIds).toEqual([]);
            expect(plan.didImmediateWarmCacheRelevantRenderableChange).toBe(false);

            // What DOES move is the activity ordering, which is correct and is what reorders the row.
            // Without this the assertions above would also hold for a patch that changed nothing.
            expect(plan.changedCount).toBe(1);
            expect(plan.noopPatchCount).toBe(0);
            expect(plan.nextRenderables.s_unread.seq).toBe(11);
            expect(plan.nextRenderables.s_unread.meaningfulActivityAt).toBe(9_000);
            expect(plan.didDeferredWarmCacheRelevantRenderableChange).toBe(true);
        });

        it('does rebuild when the same activity is what crosses the session into unread', () => {
            const plan = planSessionListRenderablePatches({
                previousRenderables: {
                    s_unread: makeUnreadRow({
                        lastViewedSessionSeq: 10,
                        hasUnreadMessages: false,
                        unreadSince: null,
                    }),
                },
                patches: [{ sessionId: 's_unread', patch: { ...FURTHER_MESSAGE_PATCH } }],
                isSessionListViewDataUninitialized: false,
                rebuildOnAttentionPromotionFieldsChange: true,
            });

            expect(plan.attentionPromotionFieldChangeCount).toBe(1);
            expect(plan.needsSessionListViewDataRebuild).toBe(true);
            expect(plan.nextRenderables.s_unread.unreadSince).toBe(9_000);
        });
    });

    describe('window-scoped replacement removal', () => {
        const pagedIn = makeRenderable('s_paged_in', { meaningfulActivityAt: 100, createdAt: 100 });
        const archivedInWindow = makeRenderable('s_archived', { meaningfulActivityAt: 900, createdAt: 900 });
        const head = makeRenderable('s_head', { meaningfulActivityAt: 1_000, createdAt: 1_000 });

        it('keeps rows the user paged in below the range the response covers', () => {
            const plan = planSessionListRenderableReplacement({
                previousRenderables: {
                    s_head: head,
                    s_archived: archivedInWindow,
                    s_paged_in: pagedIn,
                },
                incomingRenderables: [head, archivedInWindow],
                removalWindow: resolveSessionListRenderableRemovalWindow([head, archivedInWindow]),
                isSessionListViewDataUninitialized: false,
            });

            expect(plan.nextRenderables.s_paged_in).toBe(pagedIn);
            expect(plan.removedSessionIds).toEqual([]);
        });

        it('still evicts a row the response omits from inside the range it covers', () => {
            const plan = planSessionListRenderableReplacement({
                previousRenderables: {
                    s_head: head,
                    s_archived: archivedInWindow,
                    s_paged_in: pagedIn,
                },
                // `s_archived` was archived, so the refreshed first page omits it even
                // though its activity time sits inside the covered range.
                incomingRenderables: [head, pagedIn],
                removalWindow: resolveSessionListRenderableRemovalWindow([head, pagedIn]),
                isSessionListViewDataUninitialized: false,
            });

            expect(plan.removedSessionIds).toEqual(['s_archived']);
            expect(plan.nextRenderables.s_archived).toBeUndefined();
            expect(plan.nextRenderables.s_paged_in).toBeDefined();
        });

        it('sweeps every omitted row when the response covers the whole list', () => {
            const plan = planSessionListRenderableReplacement({
                previousRenderables: {
                    s_head: head,
                    s_archived: archivedInWindow,
                    s_paged_in: pagedIn,
                },
                incomingRenderables: [head],
                removalWindow: null,
                isSessionListViewDataUninitialized: false,
            });

            expect([...plan.removedSessionIds].sort()).toEqual(['s_archived', 's_paged_in']);
        });

        it('evicts rows sharing the oldest covered activity time, as an unwindowed replacement would', () => {
            const tied = makeRenderable('a_row', { meaningfulActivityAt: 500, createdAt: 500 });
            const lastCovered = makeRenderable('z_row', { meaningfulActivityAt: 500, createdAt: 500 });
            const plan = planSessionListRenderableReplacement({
                previousRenderables: { a_row: tied, z_row: lastCovered },
                incomingRenderables: [lastCovered],
                removalWindow: resolveSessionListRenderableRemovalWindow([lastCovered]),
                isSessionListViewDataUninitialized: false,
            });

            expect(plan.removedSessionIds).toEqual(['a_row']);
        });
    });
});
