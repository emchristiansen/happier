import {
    MACHINE_SESSION_RUNNER_EXITED_EVENT,
    MachineSessionRunnerExitedAckSchema,
    MachineSessionRunnerExitedRequestSchema,
    SESSION_PUBLISHER_LEGACY_ALIVE_EVENT,
    SESSION_PUBLISHER_LEGACY_END_EVENT,
    SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SessionPublisherLegacyAliveSchema,
    SessionPublisherLegacyEndSchema,
    SessionRuntimeActivityCloseAckSchema,
    SessionRuntimeActivityCloseRequestSchema,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeActivityProjection,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import type { SessionParticipantCursor } from '@/app/session/changeTracking/markSessionParticipantsChanged';
import { publishSessionPublisherLifecycleUpdate } from '@/app/session/runtimeActivity/publishPublisherLifecycleUpdate';
import type { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { describeLoggableError } from '@/utils/logging/describeLoggableError';
import { warn } from '@/utils/logging/log';

type RuntimeActivitySnapshotEventSocket = Readonly<{
    on: (event: string, handler: (value: unknown, acknowledge?: (value: unknown) => void) => void) => unknown;
}>;

type RuntimeActivitySnapshotPresence = ReturnType<typeof createSessionPublisherPresence>;

const releasedAliveOperationTails = new WeakMap<object, Promise<void>>();
const RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS = 60_000;
/**
 * Backoff after an attempt that did not persist. The first unproductive attempt retries on the very
 * next heartbeat so a one-off transient failure recovers immediately; consecutive ones back off
 * exponentially up to the normal persistence interval.
 *
 * Arming only on success let a saturated database be answered with *more* write attempts: released
 * heartbeats arrive every 2s while thinking and every 15s idle, so a failing session retried 6-30x
 * more often than a healthy one, exactly while the contended resource was exhausted. A permanently
 * unproductive attempt (a superseded socket) behaved the same way.
 */
const RELEASED_ALIVE_RETRY_BACKOFF_BASE_MS = 1_000;

function resolveReleasedAliveRetryBackoffMs(consecutiveUnproductiveAttempts: number): number {
    if (consecutiveUnproductiveAttempts <= 1) return 0;
    const exponential = RELEASED_ALIVE_RETRY_BACKOFF_BASE_MS * 2 ** (consecutiveUnproductiveAttempts - 2);
    return Math.min(RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS, exponential);
}

async function serializeReleasedAliveOperation<T>(
    presence: RuntimeActivitySnapshotPresence,
    operation: () => Promise<T>,
): Promise<T> {
    const prior = releasedAliveOperationTails.get(presence) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation);
    releasedAliveOperationTails.set(presence, result.then(() => {}, () => {}));
    return await result;
}

export type PublishRuntimeActivitySnapshotProjection = (params: Readonly<{
    sessionId: string;
    projection?: SessionRuntimeActivityProjection;
    active?: boolean;
    activeAt?: number;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    badgeAttentionChanged?: boolean;
    participantCursor: SessionParticipantCursor;
}>) => Promise<void>;

export function registerSessionRuntimeActivitySnapshotSocketEvent(params: Readonly<{
    socket: RuntimeActivitySnapshotEventSocket;
    presence: RuntimeActivitySnapshotPresence;
    binding: Readonly<{ accountId: string; machineId: string; sessionId: string }>;
    publish: PublishRuntimeActivitySnapshotProjection;
    /** Clock for the released-heartbeat persistence window (mirrors `createSessionPublisherPresence`). */
    nowMs?: () => number;
}>): void {
    const nowMs = params.nowMs ?? (() => Date.now());
    const publishParticipants = async (published: Readonly<{
        participantCursors: readonly SessionParticipantCursor[];
        projection?: SessionRuntimeActivityProjection;
        active?: boolean;
        activeAt?: Date;
        latestTurnId?: string | null;
        latestTurnStatus?: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt?: number | null;
        lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
        badgeAttentionChanged?: boolean;
    }>): Promise<void> => {
        await Promise.all(published.participantCursors.map(async (participantCursor) => {
            await params.publish({
                sessionId: params.binding.sessionId,
                participantCursor,
                ...(published.projection ? { projection: published.projection } : {}),
                ...(typeof published.active === 'boolean' ? { active: published.active } : {}),
                ...(published.activeAt ? { activeAt: published.activeAt.getTime() } : {}),
                ...('latestTurnId' in published ? { latestTurnId: published.latestTurnId } : {}),
                ...('latestTurnStatus' in published ? { latestTurnStatus: published.latestTurnStatus } : {}),
                ...('latestTurnStatusObservedAt' in published
                    ? { latestTurnStatusObservedAt: published.latestTurnStatusObservedAt }
                    : {}),
                ...('lastRuntimeIssue' in published ? { lastRuntimeIssue: published.lastRuntimeIssue } : {}),
                ...(typeof published.badgeAttentionChanged === 'boolean'
                    ? { badgeAttentionChanged: published.badgeAttentionChanged }
                    : {}),
            });
        }));
    };
    const registrationFanouts = new Map<string, Promise<void>>();
    let closeFanout: Promise<void> | null = null;
    const publishTransitionOnce = async (
        transition: 'registration' | 'close',
        published: Parameters<typeof publishParticipants>[0],
    ): Promise<void> => {
        const registrationKey = published.activeAt
            ? `${published.activeAt.getTime()}:${published.projection?.revision ?? 'reachability'}`
            : null;
        const current = transition === 'registration' && registrationKey !== null
            ? registrationFanouts.get(registrationKey)
            : closeFanout;
        if (current) {
            await current;
            return;
        }

        const attempt = publishParticipants(published);
        if (transition === 'registration' && registrationKey !== null) registrationFanouts.set(registrationKey, attempt);
        else closeFanout = attempt;
        try {
            await attempt;
        } catch (error) {
            if (transition === 'registration' && registrationKey !== null && registrationFanouts.get(registrationKey) === attempt) {
                registrationFanouts.delete(registrationKey);
            }
            if (transition === 'close' && closeFanout === attempt) closeFanout = null;
            throw error;
        }
    };
    let legacyAliveInFlight = false;
    let nextLegacyAliveAttemptAtMs: number | null = null;
    let consecutiveUnproductiveLegacyAliveAttempts = 0;

    /** Arm the next allowed attempt from the outcome of the one that just settled. */
    const armLegacyAliveAttemptWindow = (persisted: boolean): void => {
        if (persisted) {
            consecutiveUnproductiveLegacyAliveAttempts = 0;
            nextLegacyAliveAttemptAtMs = nowMs() + RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS;
            return;
        }
        consecutiveUnproductiveLegacyAliveAttempts += 1;
        nextLegacyAliveAttemptAtMs = nowMs()
            + resolveReleasedAliveRetryBackoffMs(consecutiveUnproductiveLegacyAliveAttempts);
    };

    params.socket.on(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, async (value, acknowledge) => {
        const request = SessionRuntimeActivitySnapshotRequestSchema.safeParse(value);
        if (!request.success || request.data.sessionId !== params.binding.sessionId) {
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: 'rejected',
                reason: 'invalid_request',
            }));
            return;
        }

        try {
            const result = await params.presence.publishSnapshot({
                socket: params.socket,
                binding: params.binding,
                completeSnapshot: request.data.snapshot,
            });
            if (result.status === 'applied' || ('activeAt' in result && result.status === 'unchanged')) {
                const published = {
                    participantCursors: result.participantCursors,
                    ...(result.status === 'applied' ? { projection: result.projection } : {}),
                    ...('activeAt' in result ? { active: true, activeAt: result.activeAt } : {}),
                };
                if ('activeAt' in result) await publishTransitionOnce('registration', published);
                else await publishParticipants(published);
            }
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: result.status,
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                ...(result.status === 'applied' || result.status === 'unchanged'
                    ? { projection: result.projection }
                    : { reason: result.reason }),
            }));
        } catch {
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: 'retryable',
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                reason: 'internal',
            }));
        }
    });

    params.socket.on(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, async (value, acknowledge) => {
        const request = SessionRuntimeActivityCloseRequestSchema.safeParse(value);
        if (!request.success || request.data.sessionId !== params.binding.sessionId) {
            acknowledge?.({ status: 'rejected', reason: 'invalid_request' });
            return;
        }
        try {
            const result = await serializeReleasedAliveOperation(
                params.presence,
                async () => await params.presence.closePublisher({ socket: params.socket }),
            );
            if (result.status === 'closed') {
                await publishTransitionOnce('close', {
                    participantCursors: result.participantCursors,
                    active: false,
                    activeAt: result.activeAt,
                    ...(result.projection ? { projection: result.projection } : {}),
                    ...(result.turnProjection ?? {}),
                });
            }
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: result.status === 'superseded' ? 'rejected' : result.status,
                sessionId: request.data.sessionId,
                ...(result.status === 'rejected' || result.status === 'superseded'
                    ? { reason: result.status === 'superseded' ? 'superseded' : result.reason }
                    : {}),
            }));
        } catch {
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: 'retryable',
                sessionId: request.data.sessionId,
                reason: 'internal',
            }));
        }
    });

    params.socket.on(SESSION_PUBLISHER_LEGACY_ALIVE_EVENT, async (value) => {
        const alive = SessionPublisherLegacyAliveSchema.safeParse(value);
        if (!alive.success || alive.data.sid !== params.binding.sessionId) return;
        if (legacyAliveInFlight) return;
        if (nextLegacyAliveAttemptAtMs !== null && nowMs() < nextLegacyAliveAttemptAtMs) return;
        legacyAliveInFlight = true;
        try {
            const persisted = await serializeReleasedAliveOperation(params.presence, async () => {
                const touched = await params.presence.touchPublisher({ socket: params.socket });
                if (touched.status === 'touched') {
                    return { status: 'touched' as const, touched };
                }
                if (touched.status !== 'unregistered') return { status: 'unchanged' as const };
                const registered = await params.presence.registerPublisher({
                    socket: params.socket,
                    binding: params.binding,
                    completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
                });
                if (registered.status !== 'registered') return { status: 'unchanged' as const };
                return { status: 'registered' as const, registered };
            });
            armLegacyAliveAttemptWindow(persisted.status !== 'unchanged');
            if (persisted.status === 'touched') {
                await publishParticipants({
                    participantCursors: persisted.touched.participantCursors,
                    active: true,
                    activeAt: persisted.touched.activeAt,
                });
            } else if (persisted.status === 'registered') {
                await publishTransitionOnce('registration', {
                    participantCursors: persisted.registered.participantCursors,
                    active: true,
                    activeAt: persisted.registered.activeAt,
                    ...(persisted.registered.activity.status === 'applied'
                        ? { projection: persisted.registered.activity.projection }
                        : {}),
                });
            }
        } catch (error) {
            armLegacyAliveAttemptWindow(false);
            warn(
                { module: 'session-publisher-presence', error: describeLoggableError(error) },
                'Failed to adapt released session-alive event',
            );
            // Released heartbeat events have no acknowledgement channel; the next heartbeat retries
            // once the backoff armed above elapses.
        } finally {
            legacyAliveInFlight = false;
        }
    });

    params.socket.on(SESSION_PUBLISHER_LEGACY_END_EVENT, async (value) => {
        const ended = SessionPublisherLegacyEndSchema.safeParse(value);
        if (!ended.success || ended.data.sid !== params.binding.sessionId) return;
        try {
            const result = await serializeReleasedAliveOperation(
                params.presence,
                async () => await params.presence.closePublisher({ socket: params.socket }),
            );
            if (result.status !== 'closed') return;
            await publishTransitionOnce('close', {
                participantCursors: result.participantCursors,
                active: false,
                activeAt: result.activeAt,
                ...(result.projection ? { projection: result.projection } : {}),
                ...(result.turnProjection ?? {}),
            });
        } catch (error) {
            warn(
                { module: 'session-publisher-presence', error: describeLoggableError(error) },
                'Failed to adapt released session-end event',
            );
            // Released end events have no required acknowledgement; timeout remains authoritative.
        }
    });
}

/**
 * A daemon that observed its session runner exit retires that runner's publisher fence, so the
 * session stops reading `active` instead of waiting for the presence timeout. A dead runner cannot
 * close its own fence, and a dropped connection only forgets the in-memory publisher.
 *
 * The observed exit is the same physical-stop proof an acknowledged explicit machine stop carries,
 * so this reuses that capture-and-finalize path: it closes only the fence that is current when the
 * report arrives, and only for a machine that still hosts the session.
 */
export function registerMachineSessionRunnerExitedSocketEvent(params: Readonly<{
    socket: RuntimeActivitySnapshotEventSocket;
    presence: RuntimeActivitySnapshotPresence;
    accountId: string;
    machineId: string;
}>): void {
    params.socket.on(MACHINE_SESSION_RUNNER_EXITED_EVENT, async (value, acknowledge) => {
        const request = MachineSessionRunnerExitedRequestSchema.safeParse(value);
        if (!request.success) {
            acknowledge?.(MachineSessionRunnerExitedAckSchema.parse({ status: 'rejected', reason: 'invalid_request' }));
            return;
        }
        const { sessionId } = request.data;
        try {
            const captured = await params.presence.captureExplicitMachineStop({
                binding: { accountId: params.accountId, machineId: params.machineId, sessionId },
            });
            if (captured.status !== 'captured') {
                acknowledge?.(MachineSessionRunnerExitedAckSchema.parse(captured.status === 'already_inactive'
                    ? { status: 'already_inactive', sessionId }
                    : { status: 'rejected', sessionId, reason: captured.reason }));
                return;
            }
            const closed = await params.presence.finalizeExplicitMachineStop({ target: captured.target });
            if (closed.status === 'closed') {
                await publishSessionPublisherLifecycleUpdate({
                    sessionId,
                    participantCursors: closed.participantCursors,
                    active: false,
                    activeAt: closed.activeAt.getTime(),
                    ...(closed.projection ? { projection: closed.projection } : {}),
                    ...(closed.turnProjection ?? {}),
                });
            }
            acknowledge?.(MachineSessionRunnerExitedAckSchema.parse(
                closed.status === 'closed' || closed.status === 'already_inactive'
                    ? { status: closed.status, sessionId }
                    : closed.status === 'superseded'
                        ? { status: 'rejected', sessionId, reason: 'superseded' }
                        : {
                            status: 'rejected',
                            sessionId,
                            reason: closed.reason === 'unauthorized' ? 'machine_control_unavailable' : closed.reason,
                        },
            ));
        } catch (error) {
            warn(
                { module: 'session-publisher-presence', sessionId, error: describeLoggableError(error) },
                'Failed to retire an exited session runner',
            );
            acknowledge?.(MachineSessionRunnerExitedAckSchema.parse({ status: 'retryable', sessionId, reason: 'internal' }));
        }
    });
}
