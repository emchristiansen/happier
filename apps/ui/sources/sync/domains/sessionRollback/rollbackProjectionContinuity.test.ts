import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { clearActiveViewingSessionsForServerScopeReset, markSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import { fetchAndApplySessions, type SessionListEncryption } from '@/sync/engine/sessions/sessionSnapshot';
import { handleUpdateContainer, resetSocketSessionProjectionStateForServerScope } from '@/sync/engine/socket/socket';
import { clearMountedSessionRealtimeTranscriptConsumers } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import type { SessionTurnsProjectionV1, V2SessionRecord } from '@happier-dev/protocol';

import { readSessionRollbackRangesV1, resolveTranscriptRollbackActions } from './rollbackUiSupport';

// Opening a session runs through the real Sync instance; only its transport and platform edges are stubbed.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    });
});
vi.mock('@/log', () => ({ log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        onAgentRequest: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));
vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));
const apiSocketRequest = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: apiSocketRequest,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

/**
 * Rollback-to-point actions must survive the session-list refresh that follows detail
 * hydration or a socket turn update. Since candidate R6 the multi-session reads omit
 * `rollbackEligibleTurnStarts` (R5 list rows carried it); only `GET /v2/sessions/:id`,
 * the turns projection and turn-mutation socket updates still carry it. Each scenario is
 * run against both list-row shapes and must offer the same transcript actions.
 */

const initialStorageState = storage.getInitialState();
const credentials = { token: 'test-token', secret: 'test-secret' } as AuthCredentials;
const metadata = { path: '/repo', host: 'localhost', flavor: 'codex', codexBackendMode: 'appServer' };
const noRollbackMetadata = { path: '/repo', host: 'localhost', flavor: 'claude' };

type ListRowShape = 'R5 list row carries starts' | 'R6 list row omits starts';
const LIST_ROW_SHAPES: readonly ListRowShape[] = ['R5 list row carries starts', 'R6 list row omits starts'];

function eligibleTurn(turnId: string, startSeq: number, endSeq: number): SessionTurnsProjectionV1['turns'][number] {
    return {
        turnId,
        status: 'completed',
        startedAt: startSeq,
        updatedAt: endSeq,
        terminalAt: endSeq,
        transcriptAnchors: {
            startUserMessageSeq: startSeq,
            userMessageSeqs: [startSeq],
            startSeqInclusive: startSeq,
            endSeqInclusive: endSeq,
        },
        rollback: { state: 'eligible', updatedAt: endSeq },
    };
}

function turnsProjection(sessionId: string, turnCount: 2 | 3): SessionTurnsProjectionV1 {
    const turns = [eligibleTurn('turn-1', 1, 2), eligibleTurn('turn-2', 3, 4), eligibleTurn('turn-3', 5, 6)].slice(0, turnCount);
    return { v: 1, sessionId, latestTurnId: `turn-${turnCount}`, updatedAt: turnCount * 2, turns };
}

function sessionRow(sessionId: string, overrides: Partial<V2SessionRecord> = {}): V2SessionRecord {
    return {
        id: sessionId,
        seq: 4,
        createdAt: 1,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify(metadata),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        share: null,
        latestTurnId: 'turn-2',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 100,
        ...overrides,
    };
}

function listRow(shape: ListRowShape, sessionId: string, starts: number[], overrides: Partial<V2SessionRecord> = {}): V2SessionRecord {
    const row = sessionRow(sessionId, overrides);
    return shape === 'R5 list row carries starts' ? { ...row, rollbackEligibleTurnStarts: starts } : row;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const plainSessionByIdEncryption = {
    decryptEncryptionKey: async () => null,
    initializeSessions: async () => {},
    getSessionEncryption: () => null,
};

const plainSessionListEncryption = {
    decryptEncryptionKey: async () => null,
    decryptEncryptionKeys: async (values: readonly string[]) => values.map(() => null),
    initializeSessions: async () => {},
    removeSessionEncryption: () => {},
    getSessionEncryption: () => null,
} as unknown as SessionListEncryption;

const applySessions = (sessions: Parameters<ReturnType<typeof storage.getState>['applySessions']>[0]) =>
    storage.getState().applySessions(sessions);

/** The exact-read path (`GET /v2/sessions/:id` + `/v1/sessions/:id/turns`), wired as sync.ts does. */
async function hydrateSessionDetail(sessionId: string, params: Readonly<{
    row: V2SessionRecord;
    projection: SessionTurnsProjectionV1;
    includeTurnsProjection?: boolean;
}>): Promise<void> {
    const result = await fetchAndApplySessionById({
        sessionId,
        credentials,
        clientEncryptionRequirement: 'follow_account',
        encryption: plainSessionByIdEncryption,
        sessionDataKeys: new Map(),
        request: async (path) => {
            if (path === `/v2/sessions/${sessionId}`) return jsonResponse({ session: params.row });
            if (path === `/v1/sessions/${sessionId}/turns`) return jsonResponse(params.projection);
            throw new Error(`Unexpected path ${path}`);
        },
        applySessions,
        getExistingSession: (id) => storage.getState().sessions[id] ?? null,
        includeTurnsProjection: params.includeTurnsProjection,
        log: { log: () => {} },
    });
    expect(result.ok).toBe(true);
}

/**
 * The list refresh re-applies a row to the stored session only when its payload versions moved
 * past the stored session (a missed update, e.g. after reconnect) or when the row is required
 * (pinned / kept-in-attention organization rows are re-applied on every refresh).
 */
type RefreshTrigger = 'pinned row' | 'missed agent-state update';
const REFRESH_TRIGGERS: readonly RefreshTrigger[] = ['pinned row', 'missed agent-state update'];
const SCENARIOS = REFRESH_TRIGGERS.flatMap((trigger) => LIST_ROW_SHAPES.map((shape) => [trigger, shape] as const));

function refreshRow(trigger: RefreshTrigger, shape: ListRowShape, sessionId: string, starts: number[], overrides: Partial<V2SessionRecord> = {}): V2SessionRecord {
    const stored = storage.getState().sessions[sessionId];
    return listRow(shape, sessionId, starts, {
        ...overrides,
        ...(trigger === 'missed agent-state update' ? { agentStateVersion: (stored?.agentStateVersion ?? 1) + 1 } : {}),
    });
}

/** A replacing `/v2/sessions` page refresh, wired as sync.ts `fetchSessionsOnce` wires it. */
async function refreshSessionList(rows: readonly V2SessionRecord[], params: Readonly<{
    trigger: RefreshTrigger | 'unchanged row';
}>): Promise<void> {
    const required = params.trigger === 'pinned row';
    await fetchAndApplySessions({
        credentials,
        encryption: plainSessionListEncryption,
        sessionDataKeys: new Map(),
        request: async () => jsonResponse({ sessions: rows, nextCursor: null, hasNext: false }),
        getExistingSession: (id) => storage.getState().sessions[id] ?? null,
        getCurrentSessionListRenderable: (id) => storage.getState().sessionListRenderables[id] ?? null,
        applySessionListRenderables: (sessions) => storage.getState().replaceSessionListRenderables(sessions),
        applySessionListRenderablePatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
        applySessions,
        activeSessionIds: rows.map((row) => row.id),
        ...(required ? { requiredHydrationSessionIds: rows.map((row) => row.id), awaitSessionListHydration: true } : {}),
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });
    for (const row of rows) {
        expect(storage.getState().sessionListRenderables[row.id]?.updatedAt).toBe(row.updatedAt);
    }
    if (params.trigger === 'unchanged row') return;
    // The row really reached the stored session the transcript reads.
    await vi.waitFor(() => {
        for (const row of rows) expect(storage.getState().sessions[row.id]?.updatedAt).toBe(row.updatedAt);
    });
}

function userText(id: string, seq: number): Message {
    return { kind: 'user-text', id, seq, localId: id, createdAt: seq, text: `prompt ${id}` };
}

function agentText(id: string, seq: number): Message {
    return { kind: 'agent-text', id, seq, localId: id, createdAt: seq, text: `reply ${id}` };
}

const transcript: Record<string, Message> = {
    u1: userText('u1', 1),
    a1: agentText('a1', 2),
    u2: userText('u2', 3),
    a2: agentText('a2', 4),
    u3: userText('u3', 5),
    a3: agentText('a3', 6),
};

function storedSession(sessionId: string): Session {
    const session = storage.getState().sessions[sessionId];
    if (!session) throw new Error(`Session ${sessionId} is not in the store`);
    return session;
}

function transcriptRollbackTargets(sessionId: string, messageIds: readonly string[]): Record<string, number | null> {
    const session = storedSession(sessionId);
    const actions = resolveTranscriptRollbackActions({
        session,
        messageIdsOldestFirst: messageIds,
        messagesById: transcript,
        rollbackRanges: readSessionRollbackRangesV1(session.metadata as Record<string, unknown> | null),
    });
    return Object.fromEntries(Object.entries(actions).map(([messageId, action]) => [
        messageId,
        action.target.type === 'before_user_message' ? action.target.userMessageSeq : null,
    ]));
}

const TWO_TURNS = ['u1', 'a1', 'u2', 'a2'] as const;
const THREE_TURNS = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'] as const;

describe('transcript rollback actions across session-list refreshes', () => {
    beforeEach(() => {
        resetSocketSessionProjectionStateForServerScope();
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        storage.setState(initialStorageState, true);
    });

    afterEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        storage.setState(initialStorageState, true);
        apiSocketRequest.mockReset();
    });

    it.each(SCENARIOS)('keeps detail-hydrated actions after a list refresh (%s, %s)', async (trigger, shape) => {
        const sessionId = 's_rollback_after_detail';
        await hydrateSessionDetail(sessionId, {
            row: sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }),
            projection: turnsProjection(sessionId, 2),
        });
        expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });

        await refreshSessionList([refreshRow(trigger, shape, sessionId, [1, 3], { updatedAt: 200, activeAt: 200 })], { trigger });

        expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
    });

    it.each(LIST_ROW_SHAPES)('keeps the detailed session when a list row carries no new payload, recording only its eligibility (%s)', async (shape) => {
        const sessionId = 's_rollback_unchanged_row';
        await hydrateSessionDetail(sessionId, {
            row: sessionRow(sessionId),
            projection: turnsProjection(sessionId, 2),
        });
        const before = storedSession(sessionId);

        await refreshSessionList([listRow(shape, sessionId, [1, 3], { updatedAt: 200, activeAt: 200 })], { trigger: 'unchanged row' });

        // The warm row is not re-decrypted: the detailed payload and projection survive. Its
        // eligibility still reaches the store, since an earlier-turn mutation can change
        // eligibility without changing any row field the warm check compares.
        const after = storedSession(sessionId);
        expect(after.metadata).toBe(before.metadata);
        expect(after.agentState).toBe(before.agentState);
        expect(after.sessionTurns?.latestTurnId).toBe('turn-2');
        expect(after.rollbackEligibleTurnStarts).toEqual([1, 3]);
        expect(after.rollbackEligibilityStale).toBe(shape === 'R6 list row omits starts' ? true : undefined);
        expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
    });

    it.each(SCENARIOS)('keeps socket-delivered starts after a list refresh (%s, %s)', async (trigger, shape) => {
        const sessionId = 's_rollback_after_socket';
        await hydrateSessionDetail(sessionId, {
            row: sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }),
            projection: turnsProjection(sessionId, 2),
        });

        // A third turn completes. The viewer's turn-projection refetch is still in flight, so
        // the detailed projection (latest turn-2) is stale and the socket starts are the source.
        markSessionVisible(sessionId);
        const hydrateSessionById = vi.fn();
        await handleUpdateContainer({
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions,
            fetchSessions: vi.fn(),
            applyMessages: vi.fn(),
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: vi.fn(() => false),
            getSessionMaterializedMaxSeq: vi.fn(() => 0),
            markSessionMaterializedMaxSeq: vi.fn(),
            onMessageGapDetected: vi.fn(),
            assumeUsers: vi.fn(async () => {}),
            applyTodoSocketUpdates: vi.fn(async () => {}),
            invalidateMachines: vi.fn(),
            invalidateSessions: vi.fn(),
            invalidateArtifacts: vi.fn(),
            invalidateFriends: vi.fn(),
            invalidateFriendRequests: vi.fn(),
            invalidateFeed: vi.fn(),
            invalidateAutomations: vi.fn(),
            invalidateTodos: vi.fn(),
            onTaskLifecycleEvent: vi.fn(),
            hydrateSessionById,
            log: { log: vi.fn() },
            updateData: {
                id: 'turn-3-completed',
                seq: 6,
                createdAt: 300,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-3',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 300,
                    rollbackEligibleTurnStarts: [1, 3, 5],
                },
            },
        });
        await vi.waitFor(() => expect(storedSession(sessionId).latestTurnId).toBe('turn-3'));
        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-turn-projection');
        expect(transcriptRollbackTargets(sessionId, THREE_TURNS)).toEqual({ u1: 1, u2: 3, u3: 5 });

        const turnThree = { seq: 6, latestTurnId: 'turn-3', latestTurnStatusObservedAt: 300 } as const;
        await refreshSessionList([refreshRow(trigger, shape, sessionId, [1, 3, 5], { ...turnThree, updatedAt: 400, activeAt: 400 })], { trigger });
        expect(transcriptRollbackTargets(sessionId, THREE_TURNS)).toEqual({ u1: 1, u2: 3, u3: 5 });

        // The turn-projection refetch then lands; a later list refresh still keeps the actions.
        await hydrateSessionDetail(sessionId, {
            row: sessionRow(sessionId, { ...turnThree, updatedAt: 400, activeAt: 400, agentStateVersion: storedSession(sessionId).agentStateVersion }),
            projection: turnsProjection(sessionId, 3),
        });
        expect(transcriptRollbackTargets(sessionId, THREE_TURNS)).toEqual({ u1: 1, u2: 3, u3: 5 });
        await refreshSessionList([refreshRow(trigger, shape, sessionId, [1, 3, 5], { ...turnThree, updatedAt: 500, activeAt: 500 })], { trigger });
        expect(transcriptRollbackTargets(sessionId, THREE_TURNS)).toEqual({ u1: 1, u2: 3, u3: 5 });
    });

    it.each(SCENARIOS)('lets an explicit list-row array replace the known starts (%s, %s)', async (trigger, shape) => {
        const sessionId = 's_rollback_explicit_list_array';
        await hydrateSessionDetail(sessionId, {
            row: sessionRow(sessionId),
            projection: turnsProjection(sessionId, 2),
        });
        // A server that projects list starts (R5/U) may revoke eligibility; an explicit array
        // always replaces the stored value.
        await refreshSessionList([{ ...refreshRow(trigger, shape, sessionId, [3], { updatedAt: 200, activeAt: 200 }), rollbackEligibleTurnStarts: [3] }], { trigger });
        expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([3]);
        expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u2: 3 });

        // A following row: an R5 row replaces again, an R6 row (no field) keeps the known value.
        await refreshSessionList([refreshRow(trigger, shape, sessionId, [1, 3], { updatedAt: 300, activeAt: 300 })], { trigger });
        expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual(
            shape === 'R5 list row carries starts' ? [1, 3] : [3],
        );
    });

    // Before the session is opened, an R6 list row alone carries no eligibility evidence; the
    // open path below supplies it with one exact read.
    it.each(LIST_ROW_SHAPES)('a list-only session offers actions only when the list row carries starts (%s)', async (shape) => {
        const sessionId = 's_rollback_list_only';
        await refreshSessionList([listRow(shape, sessionId, [1, 3])], { trigger: 'pinned row' });

        expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual(
            shape === 'R5 list row carries starts' ? { u1: 1, u2: 3 } : {},
        );
    });

    describe('opening a session known only from list rows', () => {
        /**
         * The real Sync instance with a plain-session transport: `GET /v2/sessions/:id` returns
         * the exact-read row (both R5 and R6 servers bound its starts to this one session), and
         * transcript reads return nothing. Returns the exact reads issued.
         */
        async function connectSync(exactRead: V2SessionRecord): Promise<{ exactReads: () => number }> {
            const { sync } = await import('@/sync/sync');
            sync.disconnectServer();
            const internals = sync as unknown as {
                credentials: AuthCredentials | null;
                encryption: unknown;
                activeServerSessionIds: Set<string>;
            };
            internals.credentials = credentials;
            internals.encryption = {
                ...plainSessionByIdEncryption,
                removeSessionEncryption: () => {},
                getMachineEncryption: () => null,
            };
            internals.activeServerSessionIds = new Set([exactRead.id]);
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${exactRead.id}`) return jsonResponse({ session: exactRead });
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            return {
                exactReads: () => apiSocketRequest.mock.calls.filter(([path]) => path === `/v2/sessions/${exactRead.id}`).length,
            };
        }

        async function settle(): Promise<void> {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        it.each(LIST_ROW_SHAPES)('shows the actions when a stored list-only session view opens (%s)', async (shape) => {
            const sessionId = 's_rollback_open_stored';
            // A pinned row is hydrated into the stored session, so the route needs no read.
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await refreshSessionList([listRow(shape, sessionId, [1, 3])], { trigger: 'pinned row' });
            const { sync } = await import('@/sync/sync');

            sync.onSessionVisible(sessionId);
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 }));
            await settle();
            // R5 rows already carried the starts; an R6 row costs exactly one exact read.
            expect(transport.exactReads()).toBe(shape === 'R5 list row carries starts' ? 0 : 1);

            // Reopening with known eligibility issues no further read.
            sync.onSessionVisible(sessionId);
            await settle();
            expect(transport.exactReads()).toBe(shape === 'R5 list row carries starts' ? 0 : 1);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
        });

        it.each(LIST_ROW_SHAPES)('shows the actions when the route hydrates a renderable-only session (%s)', async (shape) => {
            const sessionId = 's_rollback_open_renderable';
            // An ordinary refresh of a row the store has no session for yields only a list renderable.
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await refreshSessionList([listRow(shape, sessionId, [1, 3])], { trigger: 'unchanged row' });
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
            const { sync } = await import('@/sync/sync');

            // What `useHydrateSessionForRoute` runs for a store miss.
            await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({ kind: 'available' });

            expect(transport.exactReads()).toBe(1);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
        });

        /**
         * Eligibility changes on a turn the client never hears about (socket update missed while
         * disconnected) touch no list-row field that the client could compare. A later R6 list
         * refresh therefore only says "nothing carried"; the known starts may be outdated. The
         * stored starts stay displayed until reopening confirms them with one exact read.
         */
        const LATEST_TURN_CASES = [
            ['same latest turn', {}],
            ['changed latest turn', { latestTurnId: 'turn-3', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 300 }],
        ] as const satisfies readonly (readonly [string, Partial<V2SessionRecord>])[];

        async function hydrateKnownStartsOneThree(sessionId: string): Promise<void> {
            await hydrateSessionDetail(sessionId, {
                row: sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }),
                projection: turnsProjection(sessionId, 2),
            });
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
        }

        async function missedUpdateListRefresh(sessionId: string, overrides: Partial<V2SessionRecord>): Promise<void> {
            await refreshSessionList(
                [refreshRow('missed agent-state update', 'R6 list row omits starts', sessionId, [], { updatedAt: 200, activeAt: 200, ...overrides })],
                { trigger: 'missed agent-state update' },
            );
        }

        it.each(LATEST_TURN_CASES)('drops actions revoked by a missed turn update once the session reopens (%s)', async (_label, latest) => {
            const sessionId = 's_rollback_missed_revocation';
            // Current server truth after the missed mutations: no eligible turn remains.
            const transport = await connectSync(sessionRow(sessionId, {
                rollbackEligibleTurnStarts: [], agentStateVersion: 2, updatedAt: 200, activeAt: 200, ...latest,
            }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            sync.onSessionVisible(sessionId);
            await settle();
            expect(transport.exactReads()).toBe(0);

            await missedUpdateListRefresh(sessionId, latest);

            sync.onSessionVisible(sessionId);
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({}));
            await settle();
            expect(transport.exactReads()).toBe(1);
            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([]);

            // Confirmed: reopening issues no further read.
            sync.onSessionVisible(sessionId);
            await settle();
            expect(transport.exactReads()).toBe(1);
        });

        it.each(LATEST_TURN_CASES)('offers newly eligible turns missed while disconnected once the session reopens (%s)', async (_label, latest) => {
            const sessionId = 's_rollback_missed_new_turn';
            const transport = await connectSync(sessionRow(sessionId, {
                rollbackEligibleTurnStarts: [5], agentStateVersion: 2, updatedAt: 200, activeAt: 200, ...latest,
            }));
            await hydrateKnownStartsOneThree(sessionId);

            await missedUpdateListRefresh(sessionId, latest);
            const { sync } = await import('@/sync/sync');
            sync.onSessionVisible(sessionId);
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, THREE_TURNS)).toEqual({ u3: 5 }));
            await settle();
            expect(transport.exactReads()).toBe(1);
        });

        it('refreshes a visible session whose eligibility a list refresh left unconfirmed, without repeating', async () => {
            const sessionId = 's_rollback_visible_list_refresh';
            const transport = await connectSync(sessionRow(sessionId, {
                rollbackEligibleTurnStarts: [], agentStateVersion: 2, updatedAt: 200, activeAt: 200,
            }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            markSessionVisible(sessionId);
            const syncApplySessions = (sync as unknown as { applySessions: typeof applySessions }).applySessions;

            // The list refresh reaches the store through Sync, as `fetchSessionsOnce` wires it.
            await fetchAndApplySessions({
                credentials,
                encryption: plainSessionListEncryption,
                sessionDataKeys: new Map(),
                request: async () => jsonResponse({
                    sessions: [refreshRow('missed agent-state update', 'R6 list row omits starts', sessionId, [], { updatedAt: 200, activeAt: 200 })],
                    nextCursor: null,
                    hasNext: false,
                }),
                getExistingSession: (id) => storage.getState().sessions[id] ?? null,
                getCurrentSessionListRenderable: (id) => storage.getState().sessionListRenderables[id] ?? null,
                applySessionListRenderables: (sessions) => storage.getState().replaceSessionListRenderables(sessions),
                applySessionListRenderablePatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
                applySessions: syncApplySessions,
                activeSessionIds: [sessionId],
                requiredHydrationSessionIds: [sessionId],
                awaitSessionListHydration: true,
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });

            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({}));
            await settle();
            expect(transport.exactReads()).toBe(1);
        });

        it('does not loop reads when the exact read itself carries no eligibility (server without by-id starts)', async () => {
            const sessionId = 's_rollback_exact_without_starts';
            const transport = await connectSync(sessionRow(sessionId, { agentStateVersion: 2, updatedAt: 200, activeAt: 200 }));
            await hydrateKnownStartsOneThree(sessionId);
            await missedUpdateListRefresh(sessionId, {});
            const { sync } = await import('@/sync/sync');
            markSessionVisible(sessionId);

            sync.onSessionVisible(sessionId);
            await settle();
            await settle();
            // One read per open; nothing confirms or refutes the starts, so they stay displayed.
            expect(transport.exactReads()).toBe(1);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
        });

        /** An ordinary (not required) list refresh as Sync runs it, through Sync's own snapshot application. */
        async function syncListRefresh(
            rows: readonly V2SessionRecord[],
            requiredHydrationSessionIds: readonly string[] = [],
            listResponse: () => Promise<Response> = async () => jsonResponse({ sessions: rows, nextCursor: null, hasNext: false }),
        ): Promise<void> {
            const { sync } = await import('@/sync/sync');
            const syncApplySessions = (sync as unknown as { applySessions: typeof applySessions }).applySessions;
            await fetchAndApplySessions({
                credentials,
                encryption: plainSessionListEncryption,
                sessionDataKeys: new Map(),
                request: listResponse,
                getExistingSession: (id) => storage.getState().sessions[id] ?? null,
                getCurrentSessionListRenderable: (id) => storage.getState().sessionListRenderables[id] ?? null,
                applySessionListRenderables: (sessions) => storage.getState().replaceSessionListRenderables(sessions),
                applySessionListRenderablePatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
                applySessions: syncApplySessions,
                activeSessionIds: rows.map((row) => row.id),
                requiredHydrationSessionIds: [...requiredHydrationSessionIds],
                awaitSessionListHydration: true,
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });
        }

        /**
         * An earlier turn is rolled back while the client is away: eligibility drops [1, 3] to [3]
         * but the session's list row is byte-identical, so warm hydration skips it. Its snapshot
         * must still leave the known starts unconfirmed, and one exact read settles them.
         */
        it.each(['reopened', 'already visible'] as const)('drops an earlier-turn revocation behind an unchanged list row (%s)', async (mode) => {
            const sessionId = `s_rollback_earlier_turn_${mode === 'reopened' ? 'reopen' : 'visible'}`;
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [3] }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            if (mode === 'already visible') markSessionVisible(sessionId);

            await syncListRefresh([sessionRow(sessionId)]);
            if (mode === 'reopened') sync.onSessionVisible(sessionId);

            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u2: 3 }));
            await settle();
            expect(transport.exactReads()).toBe(1);
            expect(storedSession(sessionId).rollbackEligibilityStale).toBeUndefined();
        });

        it('retries a visible confirmation on the next refresh after the exact read failed', async () => {
            const sessionId = 's_rollback_visible_retry';
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [] }));
            await hydrateKnownStartsOneThree(sessionId);
            let unavailable = true;
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${sessionId}`) {
                    return unavailable
                        ? jsonResponse({ error: 'unavailable' }, 503)
                        : jsonResponse({ session: sessionRow(sessionId, { rollbackEligibleTurnStarts: [] }) });
                }
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            const { sync } = await import('@/sync/sync');
            markSessionVisible(sessionId);

            await syncListRefresh([sessionRow(sessionId)]);
            await vi.waitFor(() => expect(transport.exactReads()).toBe(1));
            await vi.waitFor(() => expect((sync as unknown as { sessionByIdHydrationInFlight: Map<string, unknown> }).sessionByIdHydrationInFlight.size).toBe(0));
            expect(storedSession(sessionId).rollbackEligibilityStale).toBe(true);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });

            unavailable = false;
            await syncListRefresh([sessionRow(sessionId)]);
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({}));
            await settle();
            expect(transport.exactReads()).toBe(2);
        });

        it.each([200, 503])('keeps a delivered revocation when an earlier exact read resolves after it (turns status %s)', async (turnsStatus) => {
            const sessionId = `s_rollback_read_older_than_update_${turnsStatus}`;
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await hydrateKnownStartsOneThree(sessionId);
            let releaseExactRead!: (response: Response) => void;
            const exactRead = new Promise<Response>((resolve) => { releaseExactRead = resolve; });
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${sessionId}`) return exactRead;
                if (path === `/v1/sessions/${sessionId}/turns`) return jsonResponse({ ...turnsProjection(sessionId, 2), turns: [] }, turnsStatus);
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            await missedUpdateListRefresh(sessionId, {});
            const { sync } = await import('@/sync/sync');
            markSessionVisible(sessionId);
            sync.onSessionVisible(sessionId);
            await vi.waitFor(() => expect(transport.exactReads()).toBe(1));

            // The revocation arrives while that read (which will report the old starts) is in flight.
            await (sync as unknown as { handleUpdate: (update: unknown) => Promise<void> }).handleUpdate({
                id: 'revocation', seq: 6, createdAt: 300,
                body: {
                    t: 'update-session', id: sessionId, latestTurnId: 'turn-2', latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 300, rollbackEligibleTurnStarts: [],
                },
            });
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({}));

            releaseExactRead(jsonResponse({ session: sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }) }));
            await settle();
            await settle();
            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([]);
            expect(storedSession(sessionId).rollbackEligibilityStale).toBeUndefined();
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({});
        });

        /**
         * A list row that carries an explicit empty array revokes every turn, even when the row is
         * warm (same payload versions) and the session keeps the detailed projection that offered
         * them. The projection survives the eligibility-only patch, so the actions must follow the
         * merged starts rather than the projection.
         */
        it.each([
            ['warm', false],
            ['required', true],
        ] as const)('drops actions on an explicit empty list-row array beside a detailed projection (%s row)', async (_label, required) => {
            const sessionId = `explicit_empty_${_label}`;
            await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [] }));
            await hydrateKnownStartsOneThree(sessionId);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
            const before = storedSession(sessionId);

            await syncListRefresh([sessionRow(sessionId, { rollbackEligibleTurnStarts: [] })], required ? [sessionId] : []);
            await settle();

            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([]);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({});
            if (!required) expect(storedSession(sessionId).metadata).toBe(before.metadata);
        });

        /**
         * Two socket-triggered hydrations: the first one's turns projection (still eligible) is held
         * while a newer socket update revokes every turn and its own hydration finds the turns
         * endpoint unavailable. When the held projection finally resolves it is older evidence: it
         * neither restores the starts nor replaces the stored projection, and no action returns.
         */
        it.each([
            ['eligible', true],
            ['empty', false],
        ] as const)('keeps a socket revocation when an older turns projection resolves after it (older projection %s)', async (_label, oldEligible) => {
            const sessionId = `older_projection_${_label}`;
            await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            const syncUpdates = sync as unknown as { handleUpdate: (update: unknown) => Promise<void> };
            markSessionVisible(sessionId);
            let releaseProjection!: (response: Response) => void;
            const heldProjection = new Promise<Response>((resolve) => { releaseProjection = resolve; });
            let turnsCalls = 0;
            let byIdCalls = 0;
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${sessionId}`) {
                    byIdCalls += 1;
                    return jsonResponse({ session: sessionRow(sessionId, { rollbackEligibleTurnStarts: byIdCalls === 1 ? [1, 3] : [] }) });
                }
                if (path === `/v1/sessions/${sessionId}/turns`) {
                    turnsCalls += 1;
                    return turnsCalls === 1 ? heldProjection : jsonResponse({ error: 'unavailable' }, 503);
                }
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            const update = (id: string, seq: number, createdAt: number, starts: number[]) => syncUpdates.handleUpdate({
                id, seq, createdAt,
                body: { t: 'update-session', id: sessionId, latestTurnId: 'turn-2', latestTurnStatus: 'completed', latestTurnStatusObservedAt: createdAt, rollbackEligibleTurnStarts: starts },
            });

            await update('eligible', 5, 200, [1, 3]);
            await vi.waitFor(() => expect(turnsCalls).toBe(1));
            await update('revoke', 6, 300, []);
            await vi.waitFor(() => expect(turnsCalls).toBe(2));
            await settle();
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({});
            const projectionBeforeRelease = storedSession(sessionId).sessionTurns;

            const olderProjection = turnsProjection(sessionId, 2);
            releaseProjection(jsonResponse({ ...olderProjection, turns: oldEligible ? olderProjection.turns : [] }));
            await settle();
            await settle();

            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([]);
            expect(storedSession(sessionId).sessionTurns).toBe(projectionBeforeRelease);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({});
        });

        /**
         * A list row is evidence from when its request started. A confirming row (explicit empty or
         * subset array, warm or required) between a delivered revocation and the late response of a
         * turns projection requested before that revocation must keep the revocation's order: the
         * held projection is still older and cannot restore what was revoked.
         */
        it.each([
            ['empty', 'warm', [] as number[], {}],
            ['empty', 'required', [] as number[], {}],
            ['subset', 'warm', [3], { u2: 3 }],
            ['subset', 'required', [3], { u2: 3 }],
        ] as const)('keeps a socket revocation when an older turns projection resolves after a confirming %s list array (%s row)', async (_label, rowKind, revokedStarts, expectedTargets) => {
            const required = rowKind === 'required';
            const sessionId = `confirming_list_${_label}_${rowKind}`;
            await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            const syncUpdates = sync as unknown as { handleUpdate: (update: unknown) => Promise<void> };
            markSessionVisible(sessionId);
            let releaseProjection!: (response: Response) => void;
            const heldProjection = new Promise<Response>((resolve) => { releaseProjection = resolve; });
            let turnsCalls = 0;
            let byIdCalls = 0;
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${sessionId}`) {
                    byIdCalls += 1;
                    return jsonResponse({ session: sessionRow(sessionId, { rollbackEligibleTurnStarts: byIdCalls === 1 ? [1, 3] : [...revokedStarts] }) });
                }
                if (path === `/v1/sessions/${sessionId}/turns`) {
                    turnsCalls += 1;
                    return turnsCalls === 1 ? heldProjection : jsonResponse({ error: 'unavailable' }, 503);
                }
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            const update = (id: string, seq: number, createdAt: number, starts: readonly number[]) => syncUpdates.handleUpdate({
                id, seq, createdAt,
                body: { t: 'update-session', id: sessionId, latestTurnId: 'turn-2', latestTurnStatus: 'completed', latestTurnStatusObservedAt: createdAt, rollbackEligibleTurnStarts: [...starts] },
            });

            await update('eligible', 5, 200, [1, 3]);
            await vi.waitFor(() => expect(turnsCalls).toBe(1));
            await update('revoke', 6, 300, revokedStarts);
            await vi.waitFor(() => expect(turnsCalls).toBe(2));
            await settle();
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual(expectedTargets);

            // A later list response: its scalars are current, so a required row is re-applied.
            await syncListRefresh(
                [sessionRow(sessionId, { rollbackEligibleTurnStarts: [...revokedStarts], seq: 10, updatedAt: 400, latestTurnStatusObservedAt: 300 })],
                required ? [sessionId] : [],
            );
            await settle();
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual(expectedTargets);

            releaseProjection(jsonResponse(turnsProjection(sessionId, 2)));
            await settle();
            await settle();

            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual(revokedStarts);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual(expectedTargets);
            // No read was added to restore order: one exact read and one turns read per update.
            expect(byIdCalls).toBe(2);
            expect(turnsCalls).toBe(2);
        });

        /**
         * A list response whose request started before a delivered revocation describes the server
         * before that revocation. It is older evidence, whichever arrives last. (Its required-row
         * hydration is also refused by the older row scalars; the warm row is not.)
         */
        it.each([false, true])('drops a list row requested before a delivered revocation (required=%s)', async (required) => {
            const sessionId = `list_older_than_revocation_${required}`;
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [] }));
            await hydrateKnownStartsOneThree(sessionId);
            const { sync } = await import('@/sync/sync');
            const syncUpdates = sync as unknown as { handleUpdate: (update: unknown) => Promise<void> };
            let releaseList!: (response: Response) => void;
            let listRequested!: () => void;
            const listRequestStarted = new Promise<void>((resolve) => { listRequested = resolve; });
            const staleRow = sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] });
            const refresh = syncListRefresh([staleRow], required ? [sessionId] : [], () => {
                listRequested();
                return new Promise<Response>((resolve) => { releaseList = resolve; });
            });
            await listRequestStarted;

            // Visible, so the update reaches the stored session (and starts its own exact read).
            markSessionVisible(sessionId);
            await syncUpdates.handleUpdate({
                id: 'revoke', seq: 6, createdAt: 300,
                body: { t: 'update-session', id: sessionId, latestTurnId: 'turn-2', latestTurnStatus: 'completed', latestTurnStatusObservedAt: 300, rollbackEligibleTurnStarts: [] },
            });
            await vi.waitFor(() => expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({}));

            releaseList(jsonResponse({ sessions: [staleRow], nextCursor: null, hasNext: false }));
            await refresh;
            await settle();

            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([]);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({});
            expect(transport.exactReads()).toBe(1);
        });

        /** A projection where only turn 2 (start 3) may be rolled back. */
        function projectionAllowingOnlyTurnTwo(sessionId: string): SessionTurnsProjectionV1 {
            const projection = turnsProjection(sessionId, 2);
            return {
                ...projection,
                turns: projection.turns.map((turn) => turn.turnId === 'turn-1'
                    ? { ...turn, rollback: { state: 'not_eligible', updatedAt: 2 } }
                    : turn),
            } as SessionTurnsProjectionV1;
        }

        /**
         * Turn 1 becomes eligible again on the server while the latest turn stays the same, so the
         * stored projection still looks current. Newer starts from a list row must offer it without
         * waiting for an unrelated change to replace the projection, and without an extra read.
         */
        it.each([false, true])('offers an earlier turn made eligible again by a newer list row beside an older projection (required=%s)', async (required) => {
            const sessionId = `renewed_list_${required}`;
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await hydrateSessionDetail(sessionId, {
                row: sessionRow(sessionId, { rollbackEligibleTurnStarts: [3] }),
                projection: projectionAllowingOnlyTurnTwo(sessionId),
            });
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u2: 3 });
            const before = storedSession(sessionId);

            await syncListRefresh([sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] })], required ? [sessionId] : []);
            const { sync } = await import('@/sync/sync');
            sync.onSessionVisible(sessionId);
            await settle();

            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([1, 3]);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
            expect(storedSession(sessionId).metadata).toBe(before.metadata);
            expect(storedSession(sessionId).agentState).toBe(before.agentState);
            expect(transport.exactReads()).toBe(0);
        });

        /**
         * The same renewal delivered by a turn-mutation update whose exact read then fails. The
         * update itself is newer than the stored projection, so the renewed turn is offered without
         * depending on that read, and reopening the session stays bounded.
         */
        it('offers an earlier turn made eligible again by a socket update whose exact read fails', async () => {
            const sessionId = 'renewed_socket_read_fails';
            const transport = await connectSync(sessionRow(sessionId, { rollbackEligibleTurnStarts: [1, 3] }));
            await hydrateSessionDetail(sessionId, {
                row: sessionRow(sessionId, { rollbackEligibleTurnStarts: [3] }),
                projection: projectionAllowingOnlyTurnTwo(sessionId),
            });
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u2: 3 });
            apiSocketRequest.mockImplementation(async (path: string) => {
                if (path === `/v2/sessions/${sessionId}`) return jsonResponse({ error: 'unavailable' }, 503);
                if (path === `/v1/sessions/${sessionId}/turns`) return jsonResponse(turnsProjection(sessionId, 2));
                return jsonResponse({ messages: [], hasMore: false, nextAfterSeq: null });
            });
            const { sync } = await import('@/sync/sync');
            const syncInternals = sync as unknown as {
                handleUpdate: (update: unknown) => Promise<void>;
                sessionByIdHydrationInFlight: Map<string, unknown>;
            };
            markSessionVisible(sessionId);

            await syncInternals.handleUpdate({
                id: 'renew', seq: 7, createdAt: 400,
                body: { t: 'update-session', id: sessionId, latestTurnId: 'turn-2', rollbackEligibleTurnStarts: [1, 3] },
            });
            await vi.waitFor(() => expect(transport.exactReads()).toBe(1));
            await vi.waitFor(() => expect(syncInternals.sessionByIdHydrationInFlight.size).toBe(0));
            await settle();
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });

            sync.onSessionVisible(sessionId);
            await settle();
            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toEqual([1, 3]);
            expect(transcriptRollbackTargets(sessionId, TWO_TURNS)).toEqual({ u1: 1, u2: 3 });
            expect(transport.exactReads()).toBeLessThanOrEqual(2);
        });

        it('does not read eligibility for a session whose agent cannot roll back', async () => {
            const sessionId = 's_rollback_open_unsupported';
            const transport = await connectSync(sessionRow(sessionId, { metadata: JSON.stringify(noRollbackMetadata) }));
            await refreshSessionList([sessionRow(sessionId, { metadata: JSON.stringify(noRollbackMetadata) })], { trigger: 'pinned row' });
            expect(storedSession(sessionId).rollbackEligibleTurnStarts).toBeUndefined();
            const { sync } = await import('@/sync/sync');

            sync.onSessionVisible(sessionId);
            await settle();

            expect(transport.exactReads()).toBe(0);
        });
    });
});
