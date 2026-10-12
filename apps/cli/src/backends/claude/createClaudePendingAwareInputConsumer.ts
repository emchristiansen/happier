import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
    PendingForegroundSteerability,
    SessionProviderInputConsumer,
} from '@/agent/runtime/sessionInput/types';
import {
    resolveSessionPendingQueueDeliveryTiming,
    resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';

import type { EnhancedMode } from './loop';
import type { Session } from './session';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/**
 * Canonical Claude session input consumer: local agent queue + daemon-owned
 * server pending-queue materialization.
 *
 * Every Claude launcher that pulls batches for a live session MUST consume
 * through this (not `session.queue` directly): a raw queue wait only ever sees
 * messages the UI managed to deliver over RPC, so server-side pending rows
 * queued mid-turn silently starve until a manual "Send now" once the UI direct
 * path misses (QA C-F2/A-F3 stuck/one-behind family — live repro
 * cmqb329qm044z: turn-end drain trigger fired, but the unified launcher waited
 * on the raw queue and no materialization could ever run).
 */
export function createClaudePendingAwareInputConsumer(
    session: Session,
    opts?: Readonly<{
        onMetadataUpdate?: (() => void | Promise<void>) | undefined;
        resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
        refreshActiveTurnSteerability?: (() => Promise<PendingForegroundSteerability>) | undefined;
    }>,
): SessionProviderInputConsumer<EnhancedMode, string> {
    const consumer = createSessionProviderInputConsumer<EnhancedMode, string>({
        messageQueue: session.queue,
        session: {
            materializeNextPendingMessageSafely: async (materializeOpts) => {
                // Committed transcript messages queued locally must be processed before
                // materializing additional server pending rows. This is ordering backpressure,
                // not evidence that the durable queue is empty.
                if (session.queue.size() > 0) {
                    return { type: 'deferred' as const, reason: 'local_input_queued' as const };
                }
                const materialize = session.client.materializeNextPendingMessageSafely;
                if (typeof materialize !== 'function') return { type: 'retryable_transport' as const };
                let activeTurnSteerability = materializeOpts?.activeTurnSteerability;
                // Cached availability is presentation/advisory state only. Once the canonical
                // consumer has selected an actual Pending materialization attempt, recapture the
                // provider screen immediately before the request so neither a stale negative nor
                // a stale positive can decide the claim.
                if (opts?.refreshActiveTurnSteerability) {
                    try {
                        activeTurnSteerability = await opts.refreshActiveTurnSteerability();
                    } catch {
                        activeTurnSteerability = 'unsteerable';
                    }
                }
                return await materialize.call(session.client, {
                    ...materializeOpts,
                    ...(activeTurnSteerability ? { activeTurnSteerability } : {}),
                });
            },
            shouldAttemptPendingMaterialization: (attemptOpts) =>
                session.queue.size() <= 0
                && (session.client.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true),
            reconcilePendingQueueState: async (reconcileOpts) => {
                await session.client.reconcilePendingQueueState?.(reconcileOpts);
            },
            ...(typeof session.client.blockPendingMessageDelivery === 'function'
                ? {
                    blockPendingMessageDelivery: session.client.blockPendingMessageDelivery.bind(session.client),
                }
                : {}),
            waitForPendingEligibilityUpdate: (signal) => session.client.waitForPendingEligibilityUpdate(signal),
            ...(typeof session.client.waitForMetadataUpdate === 'function'
                ? { waitForMetadataUpdate: (signal?: AbortSignal) => session.client.waitForMetadataUpdate(signal) }
                : {}),
            ...(typeof session.client.readRuntimeActivitySnapshotTail === 'function'
                ? {
                    readRuntimeActivitySnapshotTail: session.client.readRuntimeActivitySnapshotTail.bind(session.client),
                }
                : {}),
            ...(typeof session.client.waitForRuntimeActivitySnapshotTailChange === 'function'
                ? {
                    waitForRuntimeActivitySnapshotTailChange:
                        session.client.waitForRuntimeActivitySnapshotTailChange.bind(session.client),
                }
                : {}),
        },
        pendingDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(session.accountSettings ?? null),
        resolvePendingQueueDeliveryTiming: () => resolveSessionPendingQueueDeliveryTiming(
            getActiveAccountSettingsSnapshot()?.settings ?? session.accountSettings ?? null,
        ),
        // The unified-terminal launcher supplies its exact local evaluator snapshot here. An
        // absent resolver remains conservative; UI-published capability state never authorizes
        // Pending claim/materialization.
        ...(opts?.resolveActiveTurnSteerability
            ? { resolveActiveTurnSteerability: opts.resolveActiveTurnSteerability }
            : {}),
        ...(opts?.onMetadataUpdate ? { onMetadataUpdate: opts.onMetadataUpdate } : {}),
    });
    session.registerProviderInputConsumer(consumer);
    return consumer;
}
