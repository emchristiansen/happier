import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol';
import type { SessionSyncPendingInputServerContractMode } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';

import {
    RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST,
    createRuntimeActivitySnapshotSessionMutationPublisher,
} from './runtimeActivitySnapshotSessionMutationPublisher';
import {
    createSessionMutationJournal,
    createSessionMutationOutbox,
    type CreateSessionMutationJournalParams,
    type SessionMutationOutbox,
} from './createSessionMutationOutbox';
import {
    createSessionMutationPersistenceContext,
    loadSessionMutationOutbox,
    parseQueuedSessionMutation,
} from './sessionMutationPersistence';
import {
    createSessionTurnMutation,
    createTranscriptMessageAppendMutation,
    resolveRuntimeActivitySnapshotMutationId,
} from './sessionMutationTypes';

const tempDirs: string[] = [];

function serverContract(mode: SessionSyncPendingInputServerContractMode) {
    return {
        mode,
        runtimeActivity: mode === 'session_sync_v2_pending_input_v1' ? 'v2' : mode === 'released_server_v0_2_1' ? 'legacy' : 'indeterminate',
        pendingInput: mode === 'session_sync_v2_pending_input_v1' ? 'v1' : mode === 'released_server_v0_2_1' ? 'released_server_v0_2_1' : 'indeterminate',
        pendingExactLocalId: mode === 'session_sync_v2_pending_input_v1' || mode === 'released_server_v0_2_1' ? 'unsupported' : 'indeterminate',
        sessionConnectionEpoch: 1,
        socket: { connected: true },
    } as const;
}

async function createTempActiveServerDir(): Promise<string> {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'runtime-activity-snapshot-publisher-'));
    tempDirs.push(activeServerDir);
    await mkdir(join(activeServerDir, 'session-mutations'), { recursive: true });
    return activeServerDir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}

function runtimeContext(activeServerDir: string, sessionId: string) {
    return createSessionMutationPersistenceContext({
        activeServerDir,
        custody: 'runtime',
        sessionId,
        parseQueuedMutation: parseQueuedSessionMutation,
    });
}

function createInjectedRuntimeJournal(params: Readonly<{
    activeServerDir: string;
    sessionId: string;
    deliverRuntimeActivitySnapshot: NonNullable<CreateSessionMutationJournalParams['deliverRuntimeActivitySnapshot']>;
    getSocket?: CreateSessionMutationJournalParams['getSocket'];
}>): SessionMutationOutbox {
    return createSessionMutationJournal({
        custody: 'runtime',
        sessionId: params.sessionId,
        paths: runtimeContext(params.activeServerDir, params.sessionId).paths,
        admission: parseQueuedSessionMutation,
        token: 'token',
        getSocket: params.getSocket ?? (() => ({
            connected: false,
            emit: () => undefined,
            emitWithAck: async () => ({ ok: false }),
        })),
        requestReconnect: () => {},
        deliverRuntimeActivitySnapshot: params.deliverRuntimeActivitySnapshot,
    });
}

function queuedTranscript(sessionId: string, localId: string) {
    const payload = createTranscriptMessageAppendMutation({
        sessionId,
        localId,
        content: localId,
        provenance: { kind: 'non_dependent', source: 'external' },
        createdAt: 1,
        updatedAt: 1,
    });
    return {
        kind: 'transcript_message_append' as const,
        mutationId: payload.mutationId,
        payload,
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function queuedTurn(sessionId: string, mutationId: string) {
    const payload = createSessionTurnMutation({
        sessionId,
        mutationId,
        action: 'begin',
        turnId: 'turn-1',
        observedAt: 1,
    });
    return {
        kind: 'session_turn' as const,
        mutationId,
        payload,
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function queuedSnapshot(sessionId: string, snapshot: SessionRuntimeActivitySnapshot) {
    const mutationId = resolveRuntimeActivitySnapshotMutationId(sessionId);
    return {
        kind: 'runtime_activity_snapshot' as const,
        mutationId,
        payload: {
            v: 1 as const,
            source: 'runtime_activity_snapshot' as const,
            sessionId,
            mutationId,
            snapshot,
        },
        admissionOrder: 1,
        createdAt: 1,
        attempts: 4,
        nextAttemptAt: 99_999,
    };
}

async function readPersistedRows(activeServerDir: string, sessionId: string): Promise<unknown[]> {
    const raw = JSON.parse(await readFile(
        join(activeServerDir, 'session-mutations', `session-${sessionId}.json`),
        'utf8',
    )) as { mutations?: unknown[] };
    return raw.mutations ?? [];
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime Activity complete-snapshot session mutation publisher', () => {
    it('does not deliver a hydrated Activity snapshot before the injected publisher overlays its current value', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'injected-overlay-session';
        await writeFile(join(activeServerDir, 'session-mutations', `session-${sessionId}.json`), JSON.stringify({
            v: 1,
            mutations: [{
                ...queuedSnapshot(sessionId, {
                    state: 'active',
                    activeCount: 2,
                }),
                nextAttemptAt: Date.now() + 60_000,
            }],
        }));
        const retryTimerSpy = vi.spyOn(globalThis, 'setTimeout');
        const deliveredSnapshots: SessionRuntimeActivitySnapshot[] = [];
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: runtimeContext(activeServerDir, sessionId).paths,
            admission: parseQueuedSessionMutation,
            token: 'token',
            getSocket: () => ({ connected: false, emit: () => undefined, emitWithAck: async () => ({ ok: false }) }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveredSnapshots.push(mutation.snapshot);
                return { status: 'delivered', path: 'socket' };
            },
        });
        await journal.awaitReady();
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: {
                identity: {
                    admissionOrder: 1,
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                },
                value: {
                    state: 'active',
                    activeCount: 2,
                },
            },
        });
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await journal.flush('startup');

        expect(deliveredSnapshots).toEqual([]);
        expect(retryTimerSpy).not.toHaveBeenCalled();
        retryTimerSpy.mockRestore();

        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });
        await publisher.publish({ state: 'active', activeCount: 2 });

        expect(deliveredSnapshots).toEqual([
            { state: 'active', activeCount: 2 },
        ]);
        await publisher.close();
        await journal.close();
    });

    it('forwards reconnect reoffer requests to the aggregate desired owner without caching a snapshot', async () => {
        const enqueueRuntimeActivitySnapshot = vi.fn(async (_mutation: unknown) => ({ persisted: true, delivered: false }));
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({
            sessionId: 'reconnect-session',
            journal: {
                enqueueRuntimeActivitySnapshot,
            } as unknown as SessionMutationOutbox,
        });
        const reofferDesired = vi.fn(async () => undefined);
        const unsubscribe = publisher.subscribeDesiredReoffer(reofferDesired);

        await publisher.publish({ state: 'active', activeCount: 1 });
        await publisher[RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST]();

        expect(reofferDesired).toHaveBeenCalledTimes(1);
        expect(enqueueRuntimeActivitySnapshot).toHaveBeenCalledTimes(1);

        unsubscribe();
        await publisher[RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST]();
        expect(reofferDesired).toHaveBeenCalledTimes(1);
    });

    it('composes over the session client journal without taking ownership of it', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'shared-session-journal';
        const journal = createSessionMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => ({
                connected: false,
                emit: () => undefined,
                emitWithAck: async () => ({ ok: false }),
            }),
            requestReconnect: () => {},
        });
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({
            sessionId,
            journal,
        });

        await publisher.publish({ state: 'idle', activeCount: 0 });
        await publisher.close();
        await expect(journal.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId,
            localId: 'still-open',
            content: 'still-open',
            provenance: { kind: 'non_dependent', source: 'external' },
            createdAt: 1,
            updatedAt: 1,
        }))).resolves.toEqual(expect.objectContaining({ persisted: true }));

        await journal.close();
    });

    it('delivers through the injected runtime journal without creating another journal', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'default-delivery-session';
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId,
            deliverRuntimeActivitySnapshot: async (mutation) => {
                emitted.push({
                    event: 'session-runtime-activity-snapshot',
                    payload: {
                        sessionId: mutation.sessionId,
                        mutationId: mutation.mutationId,
                        snapshot: mutation.snapshot,
                    },
                });
                return { status: 'delivered', path: 'socket' };
            },
        });
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });

        await publisher.publish({ state: 'idle', activeCount: 0 });
        await waitUntil(() => emitted.length === 1);
        expect(emitted[0]).toEqual({
            event: 'session-runtime-activity-snapshot',
            payload: {
                sessionId,
                mutationId: resolveRuntimeActivitySnapshotMutationId(sessionId),
                snapshot: { state: 'idle', activeCount: 0 },
            },
        });
        await expect(loadSessionMutationOutbox(runtimeContext(activeServerDir, sessionId))).resolves.toEqual([]);
        await publisher.close();
        await journal.close();
    });

    it('hydrates, overlays, and persists the current complete snapshot before first delivery while preserving unrelated rows', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'overlay-session';
        const stale = queuedSnapshot(sessionId, { state: 'active', activeCount: 2 });
        await writeFile(join(activeServerDir, 'session-mutations', `session-${sessionId}.json`), JSON.stringify({
            v: 1,
            mutations: [queuedTranscript(sessionId, 'transcript-1'), queuedTurn(sessionId, 'turn-begin'), stale],
        }));

        const deliveries: Array<Readonly<{ mutation: unknown; persisted: unknown[] }>> = [];
        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId,
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveries.push({
                    mutation,
                    persisted: await readPersistedRows(activeServerDir, sessionId),
                });
                return { status: 'retryable', reason: 'test_boundary_unavailable' };
            },
        });
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });

        expect(Object.keys(publisher).sort()).toEqual(['close', 'publish', 'subscribeDesiredReoffer']);
        await publisher.publish({ state: 'unknown', activeCount: 0 });
        await waitUntil(() => deliveries.length === 1);

        const firstDelivery = deliveries[0];
        if (!firstDelivery) throw new Error('expected a captured first delivery');
        const persisted = firstDelivery.persisted.map((row) => {
            const parsed = parseQueuedSessionMutation(row, sessionId);
            if (!parsed.ok) throw new Error(`unexpected dead letter: ${parsed.deadLetter.reason}`);
            return parsed.mutation;
        });
        expect(persisted.map((row) => row.kind)).toEqual([
            'runtime_activity_snapshot',
            'transcript_message_append',
            'session_turn',
        ]);
        const firstPersisted = persisted[0];
        if (firstPersisted?.kind !== 'runtime_activity_snapshot') {
            throw new Error('expected the Runtime Activity snapshot to be persisted first');
        }
        expect(firstPersisted.payload.snapshot).toEqual({ state: 'unknown', activeCount: 0 });
        expect(JSON.stringify(persisted)).not.toContain('writerGeneration');
        expect(JSON.stringify(persisted)).not.toContain('ownerScope');
        expect(JSON.stringify(persisted)).not.toContain('receipt');
        await publisher.close();
        await journal.close();
    });

    it('coalesces every newer snapshot by one deterministic session key and retains identity until transport retry', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'coalesced-session';
        const attempts: unknown[] = [];
        let deliver = false;
        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId,
            deliverRuntimeActivitySnapshot: async (mutation) => {
                attempts.push(mutation);
                return deliver
                    ? { status: 'delivered', path: 'socket' }
                    : { status: 'retryable', reason: 'lost_ack' };
            },
        });
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });
        const initial = { state: 'idle', activeCount: 0 } as const;
        const latest = { state: 'active', activeCount: 1 } as const;

        await publisher.publish(initial);
        await waitUntil(() => attempts.length >= 1);
        await publisher.publish(latest);
        const queuedAfterReplacement = await loadSessionMutationOutbox(runtimeContext(activeServerDir, sessionId));
        expect(queuedAfterReplacement.filter((row) => row.kind === 'runtime_activity_snapshot')).toEqual([
            expect.objectContaining({
                mutationId: resolveRuntimeActivitySnapshotMutationId(sessionId),
                payload: expect.objectContaining({ snapshot: latest }),
            }),
        ]);

        const custodyBeforeIdenticalOffer = journal.readRuntimeActivitySnapshotTail();
        const attemptsBeforeIdenticalOffer = attempts.length;
        await publisher.publish(latest);
        expect(journal.readRuntimeActivitySnapshotTail()).toEqual(custodyBeforeIdenticalOffer);
        expect(attempts).toHaveLength(attemptsBeforeIdenticalOffer);

        deliver = true;
        await journal.flush('flush');
        expect(attempts.at(-1)).toEqual(attempts.at(-2));
        await expect(loadSessionMutationOutbox(runtimeContext(activeServerDir, sessionId))).resolves.toEqual([]);
        await publisher.close();
        await journal.close();
    });

    it('quarantines malformed persisted snapshot envelopes before overlaying the strict current snapshot', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'strict-session';
        const mutationId = resolveRuntimeActivitySnapshotMutationId(sessionId);
        await writeFile(join(activeServerDir, 'session-mutations', `session-${sessionId}.json`), JSON.stringify({
            v: 1,
            mutations: [{
                kind: 'runtime_activity_snapshot',
                mutationId,
                payload: {
                    v: 1,
                    source: 'runtime_activity_snapshot',
                    sessionId,
                    mutationId,
                    snapshot: { state: 'active', activeCount: 0 },
                    writerGeneration: 'forbidden',
                },
                createdAt: 1,
                attempts: 0,
                nextAttemptAt: 0,
            }],
        }));

        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId,
            deliverRuntimeActivitySnapshot: async () => ({ status: 'retryable', reason: 'offline' }),
        });
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });
        await publisher.publish({ state: 'idle', activeCount: 0 });

        const rows = await loadSessionMutationOutbox(runtimeContext(activeServerDir, sessionId));
        expect(rows).toEqual([expect.objectContaining({ kind: 'runtime_activity_snapshot' })]);
        const deadLetters = JSON.parse(await readFile(
            join(activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`),
            'utf8',
        )) as { entries?: Array<{ reason?: string }> };
        expect(deadLetters.entries).toEqual([
            expect.objectContaining({ reason: 'invalid_runtime_activity_snapshot_payload' }),
        ]);
        await publisher.close();
        await journal.close();
    });

    it('rejects initial overlay persistence failure without invoking delivery', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'runtime-activity-snapshot-publisher-failure-'));
        tempDirs.push(activeServerDir);
        await writeFile(join(activeServerDir, 'session-mutations'), 'not-a-directory');
        let deliveryCount = 0;
        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId: 'storage-failure',
            deliverRuntimeActivitySnapshot: async () => {
                deliveryCount += 1;
                return { status: 'delivered', path: 'socket' };
            },
        });
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({
            sessionId: 'storage-failure',
            journal,
        });

        await expect(publisher.publish({ state: 'unknown', activeCount: 0 })).rejects.toThrow();
        expect(deliveryCount).toBe(0);
    });

    it('finishes a publish accepted before close and rejects only later publishes', async () => {
        const activeServerDir = await createTempActiveServerDir();
        const sessionId = 'close-race-session';
        const journal = createInjectedRuntimeJournal({
            activeServerDir,
            sessionId,
            deliverRuntimeActivitySnapshot: async () => ({ status: 'retryable', reason: 'offline' }),
        });
        const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId, journal });

        const acceptedPublish = publisher.publish({ state: 'idle', activeCount: 0 });
        const closing = publisher.close();
        await expect(acceptedPublish).resolves.toBeUndefined();
        await expect(closing).resolves.toBeUndefined();
        await expect(publisher.publish({ state: 'unknown', activeCount: 0 }))
            .rejects.toThrow('after publisher close');

        const rows = await loadSessionMutationOutbox(runtimeContext(activeServerDir, sessionId));
        expect(rows).toEqual([
            expect.objectContaining({
                kind: 'runtime_activity_snapshot',
                payload: expect.objectContaining({
                    mutationId: resolveRuntimeActivitySnapshotMutationId(sessionId),
                    snapshot: { state: 'idle', activeCount: 0 },
                }),
            }),
        ]);
        await journal.close();
    });

});
