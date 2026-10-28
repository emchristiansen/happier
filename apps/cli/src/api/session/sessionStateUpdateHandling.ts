import {
    normalizeSessionMetadataForRead,
    mergeSessionRuntimeActivityProjection,
    parseSessionRuntimeActivityProjectionFields,
    type SessionRuntimeActivityProjection,
} from '@happier-dev/protocol';
import type { PendingQueueRuntimeActivityProjection } from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import { tryParseJsonObject } from '@/utils/tryParseJsonRecord';

import { decodeBase64, decrypt } from '../encryption';
import type { AgentState, Metadata, Update } from '../types';
import {
    applyKnownPendingQueueState,
    readKnownPendingQueueState,
    UNKNOWN_PENDING_QUEUE_STATE,
    type PendingQueueState,
} from './pendingQueueState';

type PendingChangedDrainTriggerSnapshot = Readonly<{
    pendingCount: number | null;
    pendingBlockedCount: number | null;
    pendingVersion: number | null;
}>;

function tryDecodeSessionStateValue<T>(params: {
    rawValue: unknown;
    sessionEncryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}): { ok: true; value: T | null } | { ok: false } {
    if (params.rawValue === null) {
        return { ok: true, value: null };
    }

    if (typeof params.rawValue !== 'string') {
        return { ok: false };
    }

    if (params.sessionEncryptionMode === 'plain') {
        const parsed = tryParseJsonObject(params.rawValue);
        return parsed ? { ok: true, value: parsed as T } : { ok: false };
    }

    try {
        const decrypted = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(params.rawValue));
        return decrypted !== null ? { ok: true, value: decrypted as T } : { ok: false };
    } catch {
        return { ok: false };
    }
}

export type SessionRuntimeActivityResyncTrigger = Readonly<{
    reason: 'equal_revision_conflict';
    current: SessionRuntimeActivityProjection;
    incoming: SessionRuntimeActivityProjection;
}>;

function toPendingQueueRuntimeActivityProjection(
    projection: SessionRuntimeActivityProjection,
): PendingQueueRuntimeActivityProjection {
    return {
        runtimeActivityState: projection.state,
        runtimeActivityActiveCount: projection.activeCount,
        runtimeActivityObservedAt: projection.observedAt,
        runtimeActivityRevision: projection.revision,
    };
}

function applyRuntimeActivityProjectionUpdate(params: Readonly<{
    current: PendingQueueRuntimeActivityProjection;
    body: Record<string, unknown>;
    onResyncRequired?: (trigger: SessionRuntimeActivityResyncTrigger) => void;
}>): PendingQueueRuntimeActivityProjection {
    const incoming = parseSessionRuntimeActivityProjectionFields(params.body);
    if (incoming.kind !== 'valid') return params.current;

    const current = parseSessionRuntimeActivityProjectionFields(params.current);
    if (current.kind !== 'valid') {
        return toPendingQueueRuntimeActivityProjection(incoming.projection);
    }

    const merged = mergeSessionRuntimeActivityProjection(current.projection, incoming.projection);
    if (merged.decision === 'replace') {
        return toPendingQueueRuntimeActivityProjection(merged.projection);
    }
    if (merged.decision === 'resync_conflict') {
        params.onResyncRequired?.({
            reason: 'equal_revision_conflict',
            current: current.projection,
            incoming: incoming.projection,
        });
    }
    return params.current;
}

function isAcceptedRuntimeActivityIdleTransition(params: Readonly<{
    previous: PendingQueueRuntimeActivityProjection;
    next: PendingQueueRuntimeActivityProjection;
}>): boolean {
    if (params.previous === params.next) return false;
    return params.previous.runtimeActivityState !== 'idle'
        && params.next.runtimeActivityState === 'idle';
}

export function applyAcknowledgedRuntimeActivityProjection(params: Readonly<{
    current: PendingQueueRuntimeActivityProjection;
    projection: SessionRuntimeActivityProjection;
}>): Readonly<{
    projection: PendingQueueRuntimeActivityProjection;
    didBecomeIdle: boolean;
}> {
    const next = applyRuntimeActivityProjectionUpdate({
        current: params.current,
        body: {
            runtimeActivityState: params.projection.state,
            runtimeActivityActiveCount: params.projection.activeCount,
            runtimeActivityObservedAt: params.projection.observedAt,
            runtimeActivityRevision: params.projection.revision,
        },
    });
    return {
        projection: next,
        didBecomeIdle: isAcceptedRuntimeActivityIdleTransition({
            previous: params.current,
            next,
        }),
    };
}

export function handleSessionStateUpdate(params: {
    update: Update;
    updateSource: 'session-scoped' | 'user-scoped';
    sessionId: string;
    sessionEncryptionMode: 'e2ee' | 'plain';
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
    pendingQueueState?: PendingQueueState;
    runtimeActivityProjection?: PendingQueueRuntimeActivityProjection;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    onMetadataUpdated: () => void;
    onPendingChangedDrainTrigger?: ((snapshot: PendingChangedDrainTriggerSnapshot) => void) | undefined;
    onRuntimeActivityResyncRequired?: ((trigger: SessionRuntimeActivityResyncTrigger) => void) | undefined;
    onWarning: (message: string) => void;
}): {
    handled: boolean;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    pendingWakeSeq: number;
    pendingQueueState: PendingQueueState;
    runtimeActivityProjection: PendingQueueRuntimeActivityProjection;
} {
    const currentPendingQueueState = params.pendingQueueState ?? UNKNOWN_PENDING_QUEUE_STATE;
    const unchangedPendingQueueState = currentPendingQueueState;
    const unchangedRuntimeActivityProjection = params.runtimeActivityProjection ?? {};
    const body = params.update.body as any;
    if (body?.t === 'pending-changed') {
        const sid = body.sid ?? body.sessionId;
        if (sid !== params.sessionId) {
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq,
                pendingQueueState: unchangedPendingQueueState,
                runtimeActivityProjection: unchangedRuntimeActivityProjection,
            };
        }

        const nextPendingQueueState = readKnownPendingQueueState(body);
        if (!nextPendingQueueState) {
            params.onPendingChangedDrainTrigger?.({
                pendingCount: null,
                pendingBlockedCount: null,
                pendingVersion: null,
            });
            params.onMetadataUpdated();
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq + 1,
                pendingQueueState: unchangedPendingQueueState,
                runtimeActivityProjection: unchangedRuntimeActivityProjection,
            };
        }

        const applied = applyKnownPendingQueueState(currentPendingQueueState, nextPendingQueueState);
        if (applied.changed) {
            params.onPendingChangedDrainTrigger?.({
                pendingCount: nextPendingQueueState.pendingCount,
                pendingBlockedCount: nextPendingQueueState.pendingBlockedCount,
                pendingVersion: nextPendingQueueState.pendingVersion,
            });
            params.onMetadataUpdated();
        }
        return {
            handled: true,
            metadata: params.metadata,
            metadataVersion: params.metadataVersion,
            agentState: params.agentState,
            agentStateVersion: params.agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq + (applied.changed ? 1 : 0),
            pendingQueueState: applied.state,
            runtimeActivityProjection: unchangedRuntimeActivityProjection,
        };
    }

    if (body?.t === 'update-session') {
        const sid = body.sid ?? body.id;
        if (sid !== params.sessionId) {
            return {
                handled: true,
                metadata: params.metadata,
                metadataVersion: params.metadataVersion,
                agentState: params.agentState,
                agentStateVersion: params.agentStateVersion,
                pendingWakeSeq: params.pendingWakeSeq,
                pendingQueueState: unchangedPendingQueueState,
                runtimeActivityProjection: unchangedRuntimeActivityProjection,
            };
        }

        let metadata = params.metadata;
        let metadataVersion = params.metadataVersion;
        let agentState = params.agentState;
        let agentStateVersion = params.agentStateVersion;

        if (body.metadata && body.metadata.version > metadataVersion) {
            const decodedMetadata = tryDecodeSessionStateValue<Metadata>({
                rawValue: body.metadata.value,
                sessionEncryptionMode: params.sessionEncryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
            });
            if (decodedMetadata.ok) {
                metadata = normalizeSessionMetadataForRead(decodedMetadata.value);
                metadataVersion = body.metadata.version;
                params.onMetadataUpdated();
            }
        }

        if (body.agentState && body.agentState.version > agentStateVersion) {
            const decodedAgentState = tryDecodeSessionStateValue<AgentState>({
                rawValue: body.agentState.value,
                sessionEncryptionMode: params.sessionEncryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
            });
            if (decodedAgentState.ok) {
                agentState = decodedAgentState.value;
                agentStateVersion = body.agentState.version;
            }
        }

        const runtimeActivityProjection = applyRuntimeActivityProjectionUpdate({
            current: unchangedRuntimeActivityProjection,
            body,
            onResyncRequired: params.onRuntimeActivityResyncRequired,
        });
        const didBecomeRuntimeActivityIdle = isAcceptedRuntimeActivityIdleTransition({
            previous: unchangedRuntimeActivityProjection,
            next: runtimeActivityProjection,
        });
        if (didBecomeRuntimeActivityIdle) {
            params.onMetadataUpdated();
        }

        return {
            handled: true,
            metadata,
            metadataVersion,
            agentState,
            agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq + (didBecomeRuntimeActivityIdle ? 1 : 0),
            pendingQueueState: unchangedPendingQueueState,
            runtimeActivityProjection,
        };
    }

    if (body?.t === 'update-machine') {
        // User-scoped sockets receive global machine updates; those are expected and irrelevant to session state.
        // Session-scoped sockets should not receive machine updates; keep a warning in that case.
        if (params.updateSource === 'session-scoped') {
            params.onWarning('[SOCKET] WARNING: Session client received unexpected machine update - ignoring');
        }
        return {
            handled: true,
            metadata: params.metadata,
            metadataVersion: params.metadataVersion,
            agentState: params.agentState,
            agentStateVersion: params.agentStateVersion,
            pendingWakeSeq: params.pendingWakeSeq,
            pendingQueueState: unchangedPendingQueueState,
            runtimeActivityProjection: unchangedRuntimeActivityProjection,
        };
    }

    return {
        handled: false,
        metadata: params.metadata,
        metadataVersion: params.metadataVersion,
        agentState: params.agentState,
        agentStateVersion: params.agentStateVersion,
        pendingWakeSeq: params.pendingWakeSeq,
        pendingQueueState: unchangedPendingQueueState,
        runtimeActivityProjection: unchangedRuntimeActivityProjection,
    };
}
