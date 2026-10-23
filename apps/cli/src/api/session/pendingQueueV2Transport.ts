import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createInvalidResponseShapeError, isAuthenticationError } from '@/api/client/httpStatusError';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { createSocketAckError, emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
    AcceptedPendingSettlementRequestV1Schema,
    AcceptedPendingSettlementResponseV1Schema,
    normalizePendingDeliveryStatusV1,
    parsePendingDeliveryStatusV1,
    pendingDeliveryStatusV1ToPersistedFields,
    PendingProviderActionSchema,
    SessionMessageRoleSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1,
    PendingRequestedActionV1Schema,
    readPendingLocalId,
    type PendingProviderAction,
    type PendingRequestedActionV1,
    type SessionPendingQueueDeliveryTiming,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export type PendingMaterializationDeliveryState = Readonly<{
    mode: 'provider';
    unresolved: boolean;
}>;

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number | null;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deliveryStateMalformed?: boolean;
    requestedAction?: PendingRequestedActionV1;
    providerAction?: PendingProviderAction;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    message?: PendingQueueMaterializedMessage | null;
    pendingQueueState?: KnownPendingQueueState;
    deferredReason?: PendingQueueMaterializeDeferredReason;
    retryAfterMs?: number;
    runtimeActivityNotice?: Readonly<{ id: string; message: string }>;
    deliveryState?: PendingMaterializationDeliveryState | null;
    providerDeliveryContractInvalid?: boolean;
};

export type PendingQueueMaterializeDeferredReason =
    | 'waiting_for_runtime_activity'
    | 'runtime_activity_unknown'
    | 'pending_version_mismatch'
    | 'waiting_for_predecessor'
    | 'waiting_for_foreground_turn';

export type PendingQueueMaterializationTransportClassification =
    | 'server_rejected'
    | 'server_retryable'
    | 'publisher_lost'
    | 'socket_disconnected'
    | 'ack_timeout'
    | 'malformed_ack'
    | 'transport_failure';

export type PendingQueueMaterializationTransportErrorCode =
    | 'pending_queue_materialization_server_rejected'
    | 'pending_queue_materialization_server_retryable'
    | 'pending_queue_materialization_publisher_lost'
    | 'pending_queue_materialization_socket_disconnected'
    | 'pending_queue_materialization_ack_timeout'
    | 'pending_queue_materialization_ack_malformed'
    | 'pending_queue_materialization_transport_failure';

const PENDING_QUEUE_MATERIALIZATION_TRANSPORT_ERROR_CODES = {
    server_rejected: 'pending_queue_materialization_server_rejected',
    server_retryable: 'pending_queue_materialization_server_retryable',
    publisher_lost: 'pending_queue_materialization_publisher_lost',
    socket_disconnected: 'pending_queue_materialization_socket_disconnected',
    ack_timeout: 'pending_queue_materialization_ack_timeout',
    malformed_ack: 'pending_queue_materialization_ack_malformed',
    transport_failure: 'pending_queue_materialization_transport_failure',
} as const satisfies Record<
    PendingQueueMaterializationTransportClassification,
    PendingQueueMaterializationTransportErrorCode
>;

function readSafePendingQueueMaterializationDiagnosticValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const diagnosticValue = value.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/u.test(diagnosticValue) ? diagnosticValue : undefined;
}

function readErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}

function classifyPendingQueueMaterializationTransportCause(
    cause: unknown,
): PendingQueueMaterializationTransportClassification {
    const code = readErrorCode(cause);
    if (code === 'socket_ack_timeout') return 'ack_timeout';
    if (code === 'socket_not_connected') return 'socket_disconnected';
    return 'transport_failure';
}

export class PendingQueueMaterializationTransportAmbiguousError extends Error {
    readonly code = 'pending_queue_materialization_transport_ambiguous' as const;
    readonly diagnosticCode: PendingQueueMaterializationTransportErrorCode;
    readonly classification: PendingQueueMaterializationTransportClassification;
    readonly serverError?: string;
    readonly retryAfterMs?: number;

    constructor(
        cause: unknown,
        classification: PendingQueueMaterializationTransportClassification = classifyPendingQueueMaterializationTransportCause(cause),
        serverError?: string,
        retryAfterMs?: number,
    ) {
        super('Connected pending queue materialization did not return a valid acknowledgement');
        this.name = 'PendingQueueMaterializationTransportAmbiguousError';
        this.diagnosticCode = PENDING_QUEUE_MATERIALIZATION_TRANSPORT_ERROR_CODES[classification];
        this.classification = classification;
        const safeServerError = readSafePendingQueueMaterializationDiagnosticValue(serverError);
        if (safeServerError !== undefined) this.serverError = safeServerError;
        if (typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
            this.retryAfterMs = retryAfterMs;
        }
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

type PendingQueueWriteBody = Readonly<(
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole; requestedAction: PendingRequestedActionV1 }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole; requestedAction: PendingRequestedActionV1 }
) & Readonly<{
    deliveryMode?: 'continuation_if_no_queued_user_input';
}>>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; providerDeliveryContractInvalid?: boolean; pendingQueueState?: KnownPendingQueueState; runtimeActivityNotice?: Readonly<{ id: string; message: string }> }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason; retryAfterMs?: number; deliveryState?: PendingMaterializationDeliveryState | null }
    | { ok: false; error: unknown };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; providerDeliveryContractInvalid?: boolean; pendingQueueState?: KnownPendingQueueState; runtimeActivityNotice?: Readonly<{ id: string; message: string }> }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason; retryAfterMs?: number; deliveryState?: PendingMaterializationDeliveryState | null };

type PendingMaterializeAckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

export type ReleasedServerV021MaterializeAck =
    | Readonly<{ ok: true; didMaterialize: false }>
    | Readonly<{
        ok: true;
        didMaterialize: true;
        didWrite: boolean;
        message: Readonly<{ id: string; seq: number; localId: string }>;
    }>
    | Readonly<{
        ok: false;
        error: 'invalid-params' | 'session-not-found' | 'forbidden' | 'internal';
    }>;

type PendingMaterializePayload = Readonly<{
    sid: string;
    pendingVersion?: number;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryState?: 'provider';
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}>;

export type PendingQueueDeliveryBlockedReason = PendingDeliveryBlockedReason;

export type AcceptedPendingQueueV2DeliveryRetryDirective = Readonly<{
    retryAfterMs: number;
    correlationId?: string;
}>;

export class PendingQueueAcceptedSettlementError extends Error {
    readonly code = 'pending_queue_accepted_settlement_failed' as const;

    constructor(
        readonly settlementError: string,
        readonly retryAfterMs?: number,
        readonly correlationId?: string,
    ) {
        super(`Pending delivery accepted settlement failed: ${settlementError}`);
        this.name = 'PendingQueueAcceptedSettlementError';
    }
}

/** A failed observation of settlement, never evidence that settlement had no effect. */
export class PendingQueueAcceptedSettlementAmbiguousError extends Error {
    readonly code = 'pending_queue_accepted_settlement_ambiguous' as const;

    constructor(
        readonly classification: 'transport_failure' | 'malformed_ack',
        cause: unknown,
    ) {
        super('Pending delivery accepted settlement outcome is unconfirmed', { cause });
        this.name = 'PendingQueueAcceptedSettlementAmbiguousError';
    }
}

export function isAcceptedPendingQueueV2DeliveryRetryableError(error: unknown): boolean {
    if (error instanceof PendingQueueAcceptedSettlementAmbiguousError) return true;
    if (error instanceof PendingQueueAcceptedSettlementError) {
        return error.settlementError === 'internal' || error.settlementError === 'transaction-unavailable';
    }
    // The shared deadline and pre-emit connection check supply typed transport failures.
    // Native Socket.IO rejections are classified at the accepted transport boundary below.
    return (readErrorCode(error) === 'socket_ack_timeout' || readErrorCode(error) === 'socket_not_connected')
        && (error as { retryable?: unknown }).retryable === true;
}

export function isAcceptedPendingQueueV2DeliveryNotFound(error: unknown): boolean {
    return error instanceof PendingQueueAcceptedSettlementError && error.settlementError === 'not-found';
}

export type PendingQueueBlockedDelivery = Readonly<{
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}>;

function buildSessionRunnerHttpHeaders(token: string, contentType?: 'application/json') {
    return {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
    };
}

/**
 * Reads the accepted-settlement overload contract without turning ordinary endpoint failures into
 * retry cadence. The typed response delay is authoritative; Retry-After is a compatibility fallback.
 */
export function readAcceptedPendingQueueV2DeliveryRetryDirective(
    error: unknown,
): AcceptedPendingQueueV2DeliveryRetryDirective | null {
    if (
        error instanceof PendingQueueAcceptedSettlementError
        && error.settlementError === 'transaction-unavailable'
        && typeof error.retryAfterMs === 'number'
        && Number.isSafeInteger(error.retryAfterMs)
        && error.retryAfterMs >= 0
    ) {
        return {
            retryAfterMs: error.retryAfterMs,
            ...(error.correlationId ? { correlationId: error.correlationId } : {}),
        };
    }
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
    const responseRecord = response as Record<string, unknown>;
    if (responseRecord.status !== 503) return null;
    const data = responseRecord.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const dataRecord = data as Record<string, unknown>;
    if (dataRecord.error !== 'transaction-unavailable') return null;

    const typedRetryAfterMs = dataRecord.retryAfterMs;
    const retryAfterMs = typeof typedRetryAfterMs === 'number'
        && Number.isSafeInteger(typedRetryAfterMs)
        && typedRetryAfterMs >= 0
        ? typedRetryAfterMs
        : classifyServerEndpointError(error).retryAfterMs;
    if (retryAfterMs === undefined) return null;

    const correlationId = typeof dataRecord.correlationId === 'string'
        && /^[A-Za-z0-9_.:-]{1,160}$/u.test(dataRecord.correlationId)
        ? dataRecord.correlationId
        : undefined;
    return {
        retryAfterMs,
        ...(correlationId ? { correlationId } : {}),
    };
}

function readResolvedLocalIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const rawLocalIds = (value as Record<string, unknown>).resolvedLocalIds;
    if (!Array.isArray(rawLocalIds)) return [];
    const resolvedLocalIds: string[] = [];
    for (const rawLocalId of rawLocalIds) {
        const localId = readPendingLocalId(rawLocalId);
        if (!localId || resolvedLocalIds.includes(localId)) continue;
        resolvedLocalIds.push(localId);
    }
    return resolvedLocalIds;
}

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    const expectedPendingVersion = record.expectedPendingVersion;
    const expectedRuntimeActivityRevision = record.expectedRuntimeActivityRevision;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
        ...(typeof expectedPendingVersion === 'number'
            && Number.isSafeInteger(expectedPendingVersion)
            && expectedPendingVersion >= 0
            ? { expectedPendingVersion }
            : {}),
        ...(typeof expectedRuntimeActivityRevision === 'number'
            && Number.isSafeInteger(expectedRuntimeActivityRevision)
            && expectedRuntimeActivityRevision >= 0
            ? { expectedRuntimeActivityRevision }
            : {}),
        ...(record.deliveryState === 'provider' ? { deliveryState: 'provider' } : {}),
        ...(record.deliveryTiming === 'after_foreground_ready' || record.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: record.deliveryTiming }
            : {}),
        ...(record.foregroundState === 'ready' || record.foregroundState === 'active_steerable' || record.foregroundState === 'active_unsteerable'
            ? { foregroundState: record.foregroundState }
            : {}),
    };
}

function readPendingMaterializeDeferredReason(value: unknown): PendingQueueMaterializeDeferredReason | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const reason = (value as { deferredReason?: unknown }).deferredReason;
    return reason === 'waiting_for_runtime_activity'
        || reason === 'runtime_activity_unknown'
        || reason === 'pending_version_mismatch'
        || reason === 'waiting_for_predecessor'
        || reason === 'waiting_for_foreground_turn'
        ? reason
        : undefined;
}

function readPendingMaterializeRetryAfterMs(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const retryAfterMs = (value as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : undefined;
}

function readRuntimeActivityNotice(value: unknown): Readonly<{ id: string; message: string }> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const notice = (value as { runtimeActivityNotice?: unknown }).runtimeActivityNotice;
    if (!notice || typeof notice !== 'object') return undefined;
    const { id, message } = notice as { id?: unknown; message?: unknown };
    return typeof id === 'string' && id.length > 0 && typeof message === 'string' && message.length > 0
        ? { id, message }
        : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readSafePendingMaterializeServerError(value: unknown): string | null {
    return readSafePendingQueueMaterializationDiagnosticValue(value) ?? null;
}

function requirePendingLocalId(value: unknown): string {
    const localId = readPendingLocalId(value);
    if (localId === null) {
        throw new Error('Pending localId must not be blank');
    }
    return localId;
}

function parseReleasedServerV021MaterializeAck(value: unknown): ReleasedServerV021MaterializeAck | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.ok === false) {
        if (!hasExactKeys(record, ['ok', 'error'])) return null;
        const error = record.error;
        return error === 'invalid-params'
            || error === 'session-not-found'
            || error === 'forbidden'
            || error === 'internal'
            ? { ok: false, error }
            : null;
    }
    if (record.ok !== true || typeof record.didMaterialize !== 'boolean') return null;
    if (record.didMaterialize === false) {
        return hasExactKeys(record, ['ok', 'didMaterialize'])
            ? { ok: true, didMaterialize: false }
            : null;
    }
    if (!hasExactKeys(record, ['ok', 'didMaterialize', 'didWrite', 'message'])) return null;
    if (typeof record.didWrite !== 'boolean') return null;
    if (!record.message || typeof record.message !== 'object' || Array.isArray(record.message)) return null;
    const message = record.message as Record<string, unknown>;
    if (!hasExactKeys(message, ['id', 'seq', 'localId'])) return null;
    const id = readNonBlankOpaqueIdentifier(message.id);
    const localId = readPendingLocalId(message.localId);
    const seq = message.seq;
    if (!id || !localId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
    return {
        ok: true,
        didMaterialize: true,
        didWrite: record.didWrite,
        message: { id, seq, localId },
    };
}

/**
 * Reads the persisted delivery fields a server without the typed `deliveryStatus` sends. A row is
 * accepted exactly when it is the persisted form of the status the protocol normalizes it to, so
 * the protocol alone decides which `deliveryState` values exist. Blocked reasons are not compared:
 * an unknown reason normalizes to `unknown` rather than rejecting the row.
 */
function parseLegacyPendingRowDeliveryStatus(record: Record<string, unknown>): PendingDeliveryStatusV1 | null {
    const fields = {
        status: record.status,
        deliveryState: record.deliveryState ?? null,
        deliveryBlockedReason: record.deliveryBlockedReason ?? null,
        discardedReason: record.discardedReason ?? null,
    };
    const status = normalizePendingDeliveryStatusV1(fields);
    const persisted = pendingDeliveryStatusV1ToPersistedFields(status);
    if (persisted.status !== fields.status || persisted.deliveryState !== fields.deliveryState) return null;
    if (persisted.deliveryState !== 'blocked' && fields.deliveryBlockedReason !== null) return null;
    if (persisted.status !== 'discarded' && fields.discardedReason !== null) return null;
    if (fields.discardedReason !== null && typeof fields.discardedReason !== 'string') return null;
    return status;
}

/**
 * The typed `deliveryStatus` is the server's canonical projection and wins when present: it also
 * carries what the persisted fields cannot express, such as a queued row with an unparseable
 * requested action reading as blocked `unsupported_action`. The persisted fields are the fallback
 * for servers that predate the typed field.
 */
function readPendingRowDeliveryStatus(record: Record<string, unknown>): PendingDeliveryStatusV1 | null {
    return hasOwn(record, 'deliveryStatus')
        ? parsePendingDeliveryStatusV1(record.deliveryStatus)
        : parseLegacyPendingRowDeliveryStatus(record);
}

function arePendingDeliveryStatusesEqual(left: PendingDeliveryStatusV1, right: PendingDeliveryStatusV1): boolean {
    if (left.status !== right.status) return false;
    if (left.status === 'blocked' && right.status === 'blocked') return left.reason === right.reason;
    if (left.status === 'discarded' && right.status === 'discarded') return left.reason === right.reason;
    return true;
}

/**
 * Whether a row's persisted fields read as the same status as its typed `deliveryStatus`. They differ
 * where the server overrides the typed status, as for a queued row whose requested action it cannot
 * parse (persisted queued, typed blocked `unsupported_action`). A row with only one representation
 * has nothing to contradict.
 */
function doPersistedFieldsMatchTypedStatus(record: Record<string, unknown>, typedStatus: PendingDeliveryStatusV1): boolean {
    const hasPersistedFields = hasOwn(record, 'status')
        || hasOwn(record, 'deliveryState')
        || hasOwn(record, 'deliveryBlockedReason')
        || hasOwn(record, 'discardedReason');
    if (!hasOwn(record, 'deliveryStatus') || !hasPersistedFields) return true;
    const persistedStatus = parseLegacyPendingRowDeliveryStatus(record);
    return persistedStatus !== null && arePendingDeliveryStatusesEqual(persistedStatus, typedStatus);
}

type PendingQueueV2ProjectionEntry = Readonly<{
    localId: string;
    deliveryStatus: PendingDeliveryStatusV1;
    messageRole: SessionMessageRole | null;
    requestedAction: PendingRequestedActionV1 | null;
    persistedFieldsMatchTypedStatus: boolean;
}>;

function parsePendingQueueV2Projection(value: unknown): PendingQueueV2ProjectionEntry[] {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    if (!record || !Array.isArray(record.pending)) {
        throw new Error('Invalid pending queue delivery status projection');
    }

    const seenLocalIds = new Set<string>();
    const entries: PendingQueueV2ProjectionEntry[] = [];
    for (const row of record.pending) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Invalid pending queue delivery status projection');
        }
        const pendingRecord = row as Record<string, unknown>;
        const localId = readPendingLocalId(pendingRecord.localId);
        const deliveryStatus = readPendingRowDeliveryStatus(pendingRecord);
        const messageRole = SessionMessageRoleSchema.safeParse(pendingRecord.messageRole);
        const requestedAction = PendingRequestedActionV1Schema.safeParse(pendingRecord.requestedAction);
        if (
            localId === null
            || seenLocalIds.has(localId)
            || deliveryStatus === null
        ) {
            throw new Error('Invalid pending queue delivery status projection');
        }
        seenLocalIds.add(localId);
        entries.push({
            localId,
            deliveryStatus,
            messageRole: messageRole.success ? messageRole.data : null,
            requestedAction: requestedAction.success ? requestedAction.data : null,
            persistedFieldsMatchTypedStatus: doPersistedFieldsMatchTypedStatus(pendingRecord, deliveryStatus),
        });
    }
    return entries;
}

async function fetchPendingQueueV2List(params: {
    token: string;
    sessionId: string;
}): Promise<unknown> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.get(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        {
            headers: buildSessionRunnerHttpHeaders(params.token),
            timeout: 10_000,
        },
    );
    return response?.data;
}

async function fetchPendingQueueV2Projection(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2ProjectionEntry[]> {
    return parsePendingQueueV2Projection(await fetchPendingQueueV2List(params));
}

/** One pending row exactly as the server's pending list reported it. */
export type PendingQueueV2RowSnapshot = Readonly<{
    localId: string;
    status: 'queued' | 'discarded';
    deliveryState: 'delivering' | 'external_handoff' | 'blocked' | null;
    /** The server's stored reason, unnormalized, so an unrecognized reason is never read as a known one. */
    deliveryBlockedReason: string | null;
    position: number;
}>;

const PENDING_ROW_SNAPSHOT_DELIVERY_STATES = new Set<unknown>(['delivering', 'external_handoff', 'blocked']);

function invalidPendingRowSnapshot(): Error {
    return createInvalidResponseShapeError('Invalid pending queue row snapshot');
}

function readOptionalNonEmptyString(value: unknown): string | null | undefined {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePendingQueueV2RowSnapshot(row: unknown): PendingQueueV2RowSnapshot {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalidPendingRowSnapshot();
    const record = row as Record<string, unknown>;
    const localId = readPendingLocalId(record.localId);
    const status = record.status === 'queued' || record.status === 'discarded' ? record.status : null;
    const rawDeliveryState = record.deliveryState ?? null;
    const deliveryBlockedReason = readOptionalNonEmptyString(record.deliveryBlockedReason);
    const discardedReason = readOptionalNonEmptyString(record.discardedReason);
    const position = record.position;
    if (
        localId === null
        || status === null
        || (rawDeliveryState !== null && !PENDING_ROW_SNAPSHOT_DELIVERY_STATES.has(rawDeliveryState))
        || deliveryBlockedReason === undefined
        || discardedReason === undefined
        || typeof position !== 'number'
        || !Number.isSafeInteger(position)
    ) {
        throw invalidPendingRowSnapshot();
    }
    const deliveryState = rawDeliveryState as PendingQueueV2RowSnapshot['deliveryState'];
    if (status === 'discarded' && deliveryState !== null) throw invalidPendingRowSnapshot();
    if (deliveryBlockedReason !== null && deliveryState !== 'blocked') throw invalidPendingRowSnapshot();
    // The row's delivery status must be readable by the parser every pending-list reader shares.
    // When the typed status is present it can legitimately differ from the persisted fields (a row
    // whose requested action the server cannot read is typed blocked `unsupported_action`), so it is
    // neither compared with them nor substituted for them: the snapshot keeps the persisted fields,
    // which are what the server's handled route checks.
    if (readPendingRowDeliveryStatus(record) === null) throw invalidPendingRowSnapshot();
    return { localId, status, deliveryState, deliveryBlockedReason, position };
}

/**
 * Reads every row of the server's pending list with its persisted delivery fields and position.
 * Unlike the delivery-status projection above, which keeps only the canonical typed status, this
 * reader keeps the persisted fields exactly as stored. It fails closed on any row it cannot read
 * exactly and on duplicate local ids.
 */
export async function readPendingQueueV2RowSnapshotsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2RowSnapshot[]> {
    const data = await fetchPendingQueueV2List(params);
    const record = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : null;
    if (!record || !Array.isArray(record.pending)) throw invalidPendingRowSnapshot();
    const seenLocalIds = new Set<string>();
    return record.pending.map((row) => {
        const snapshot = parsePendingQueueV2RowSnapshot(row);
        if (seenLocalIds.has(snapshot.localId)) throw invalidPendingRowSnapshot();
        seenLocalIds.add(snapshot.localId);
        return snapshot;
    });
}

function buildPendingMaterializeBody(params: {
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Record<string, unknown> {
    return {
        ...(typeof params.expectedPendingVersion === 'number'
            ? { expectedPendingVersion: params.expectedPendingVersion }
            : {}),
        ...(typeof params.expectedRuntimeActivityRevision === 'number'
            ? { expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision }
            : {}),
        ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
        ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: params.deliveryTiming }
            : {}),
        ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') {
                throw new Error(`Unexpected pending queue socket ACK event: ${event}`);
            }
            return await target.emitWithAck('pending-materialize-next', readPendingMaterializePayload(payload));
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function createAcceptedPendingSettlementAckSocket(
    socket: Socket<ServerToClientEvents, ClientToServerEvents>,
): PendingMaterializeAckSocket {
    const build = (
        target: Socket<ServerToClientEvents, ClientToServerEvents>,
        timeoutMs?: number,
    ): PendingMaterializeAckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== ACCEPTED_PENDING_SETTLEMENT_EVENT_V1) {
                throw new Error(`Unexpected accepted pending settlement socket ACK event: ${event}`);
            }
            const request = AcceptedPendingSettlementRequestV1Schema.parse(payload);
            try {
                return await target.emitWithAck(ACCEPTED_PENDING_SETTLEMENT_EVENT_V1, request);
            } catch (error) {
                // Socket.IO's native timer can reject before the shared typed deadline.
                if (timeoutMs !== undefined && error instanceof Error && error.message === 'operation has timed out') {
                    throw createSocketAckError({
                        code: 'socket_ack_timeout',
                        event: ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
                        message: `${ACCEPTED_PENDING_SETTLEMENT_EVENT_V1} ack timed out after ${timeoutMs}ms`,
                        timeoutMs,
                    });
                }
                throw error;
            }
        },
        timeout: (ms) => build(target.timeout(ms), ms),
    });
    return build(socket);
}

function parseMaterializedMessageTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
}

function parseDeliveryState(value: unknown): {
    deliveryState: PendingMaterializationDeliveryState | null;
    malformed: boolean;
} {
    if (value === null || value === undefined) {
        return { deliveryState: null, malformed: false };
    }
    if (!value || typeof value !== 'object') {
        return { deliveryState: null, malformed: true };
    }
    const record = value as Record<string, unknown>;
    if (record.mode !== 'provider' || typeof record.unresolved !== 'boolean') {
        return { deliveryState: null, malformed: true };
    }
    return {
        deliveryState: {
            mode: 'provider',
            unresolved: record.unresolved,
        },
        malformed: false,
    };
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : null;
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : record.seq === null
            ? null
            : null;
    const localId = readPendingLocalId(record.localId);
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    const parsedRequestedAction = PendingRequestedActionV1Schema.safeParse(record.requestedAction);
    const parsedProviderAction = PendingProviderActionSchema.safeParse(record.providerAction);
    const deliveryState = parseDeliveryState(record.deliveryState);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
        ...(parsedRequestedAction.success ? { requestedAction: parsedRequestedAction.data } : {}),
        ...(parsedProviderAction.success ? { providerAction: parsedProviderAction.data } : {}),
        deliveryState: deliveryState.deliveryState,
        ...(deliveryState.malformed ? { deliveryStateMalformed: true } : {}),
    };
}

function readMaterializedMessageFromAck(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedMessage = parseMaterializedMessage(record.message);
    const topLevelDeliveryState = parseDeliveryState(record.deliveryState);
    if (parsedMessage) {
        return {
            ...parsedMessage,
            deliveryState: parsedMessage.deliveryState ?? topLevelDeliveryState.deliveryState,
            ...(parsedMessage.deliveryStateMalformed || topLevelDeliveryState.malformed
                ? { deliveryStateMalformed: true }
                : {}),
        };
    }
    return parseMaterializedMessage(record);
}

function readMaterializedLocalIdFromAck(value: unknown, message: PendingQueueMaterializedMessage | null): string | null {
    const materializedLocalId = readPendingLocalId(message?.localId);
    if (materializedLocalId !== null) return materializedLocalId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const topLevelLocalId = readPendingLocalId(record.localId);
    if (topLevelLocalId !== null) return topLevelLocalId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return readPendingLocalId(nestedLocalId);
}

function readRawMaterializedMessageRecordFromAck(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const nested = record.message;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
    return record;
}

function isProviderDeliveryMaterializationValid(params: {
    didWrite: boolean;
    didWriteExplicitFalse: boolean;
    message: PendingQueueMaterializedMessage | null;
    localId: string | null;
    rawMessageRecord: Record<string, unknown> | null;
}): boolean {
    const message = params.message;
    const localId = readPendingLocalId(message?.localId) ?? readPendingLocalId(params.localId);
    const rawMessageId = params.rawMessageRecord?.id;
    const hasValidEnvelope =
        !!message
        && params.rawMessageRecord !== null
        && localId !== null
        && message.requestedAction !== undefined
        && message.providerAction !== undefined
        && message.deliveryStateMalformed !== true
        && (rawMessageId === null || typeof rawMessageId === 'string');
    const isLegacyProviderClaim =
        hasValidEnvelope
        && params.didWrite === false
        && params.didWriteExplicitFalse === true
        && message.seq === null
        && params.rawMessageRecord?.seq === null;
    const isRowFirstProviderDelivery =
        hasValidEnvelope
        && params.didWrite === true
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && typeof rawMessageId === 'string'
        && rawMessageId.length > 0
        && typeof params.rawMessageRecord?.seq === 'number'
        && Number.isSafeInteger(params.rawMessageRecord.seq)
        && params.rawMessageRecord.seq >= 0
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true;
    return isLegacyProviderClaim || isRowFirstProviderDelivery;
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending.map((entry) => entry.localId);
}

/**
 * Local ids of the rows a mode switch or a switch-to-local discard acts on: every pending row except
 * one the app handed to an external terminal (`external_handoff`, whose custody is outside this
 * runner) and one whose typed status the server overrode so that it no longer matches the persisted
 * fields (a queued row whose requested action the server cannot parse). Queued, delivering and
 * blocked rows count, including a malformed action already persisted as blocked.
 * `listPendingQueueV2LocalIdsFromServer` remains the complete inventory.
 */
export async function listPendingQueueV2ActionableLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending
        .filter((entry) => entry.deliveryStatus.status !== 'external_handoff' && entry.persistedFieldsMatchTypedStatus)
        .map((entry) => entry.localId);
}

export type PendingQueueV2ActivationEligibility = 'eligible' | 'missing' | 'ineligible';

export async function readPendingQueueV2ActivationEligibilityFromServer(params: {
    token: string;
    sessionId: string;
    requestId: string;
}): Promise<PendingQueueV2ActivationEligibility> {
    const pending = await fetchPendingQueueV2Projection(params);
    const exact = pending.find((entry) => entry.localId === params.requestId);
    if (!exact) return 'missing';
    return exact.messageRole === 'user'
        && exact.requestedAction?.kind === 'send_now'
        && exact.deliveryStatus.status === 'queued'
        ? 'eligible'
        : 'ineligible';
}

export type PendingQueueV2DeliveryStatusEntry = Readonly<{
    localId: string;
    status: PendingDeliveryStatusV1['status'];
}>;

/**
 * Per-row delivery status projection for rows currently in the server pending queue. An absent
 * row is only an observation, not proof of settlement or exact committed delivery. The existing
 * canonical custody owner decides release from its exact terminal/committed proof; a retained
 * row's explicit status remains available to that owner.
 */
export async function listPendingQueueV2DeliveryStatusesFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2DeliveryStatusEntry[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending.map((entry) => ({
        localId: entry.localId,
        status: entry.deliveryStatus.status,
    }));
}

export async function listPendingQueueV2ProviderDeliveryLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending
        .filter((entry) => entry.deliveryStatus.status === 'delivering')
        .map((entry) => entry.localId);
}

export async function readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueBlockedDelivery | null> {
    const localId = requirePendingLocalId(params.localId);
    const pending = await fetchPendingQueueV2Projection(params);
    const entry = pending.find((candidate) => candidate.localId === localId);
    return entry?.deliveryStatus.status === 'blocked'
        ? { localId, reason: entry.deliveryStatus.reason }
        : null;
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveServerHttpBaseUrl();
    const localIds = params.localIds.map(requirePendingLocalId);
    for (const localId of localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: buildSessionRunnerHttpHeaders(params.token), timeout: 10_000 },
            );
            discarded += 1;
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            throw error;
        }
    }
    return discarded;
}

/**
 * Client wait for one `POST /v2/sessions/:id/pending` attempt (not an
 * end-to-end deadline for the send).
 *
 * A chosen value with a measured motivation. During the 2026-10-23 relay
 * saturation (episode 31), requests that completed averaged 5-6.5 s and reached
 * about 15 s, and those figures count completed requests only. Most POST
 * /pending arrivals logged no completion while the client gave up at 10 s, and
 * the relay does not cancel a handler whose client left. Server side, the
 * enqueue queues behind the relay's single SQLite connection and then runs an
 * interactive transaction whose retry scheduling is budgeted at 25 s
 * (`DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS`,
 * apps/server/sources/storage/inTx.ts); that budget is not a wall-clock bound
 * on the whole request. 30 s is three times the old wait and twice the longest
 * completion observed. It is meant to let an enqueue the relay is still working
 * on complete before the client gives up, at the cost of up to 20 s more wait
 * before a caller hears of a timeout. The figures sample completed requests
 * only, so how many of the uncompleted arrivals 30 s would have let finish is
 * unknown. It does not guarantee the relay has finished, which is why a timeout
 * is reported as unconfirmed custody with its localId.
 */
export const PENDING_ENQUEUE_HTTP_TIMEOUT_MS = 30_000;

export async function enqueuePendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    body: PendingQueueWriteBody;
}): Promise<Readonly<{ didWrite: boolean | null; terminal: boolean; suppressed: boolean }>> {
    const localId = requirePendingLocalId(params.body.localId);
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
            timeout: PENDING_ENQUEUE_HTTP_TIMEOUT_MS,
        },
    );
    const data = response?.data;
    const terminal = data && typeof data === 'object' && (data as { terminal?: unknown }).terminal === true;
    if (terminal) {
        const message = data && typeof data === 'object'
            ? (data as { message?: unknown }).message
            : null;
        const record = message && typeof message === 'object' && !Array.isArray(message)
            ? message as Record<string, unknown>
            : null;
        const proofAction = PendingRequestedActionV1Schema.safeParse(record?.requestedAction);
        if (
            !record
            || readNonBlankOpaqueIdentifier(record.id) === null
            || typeof record.seq !== 'number'
            || !Number.isSafeInteger(record.seq)
            || record.seq < 0
            || readPendingLocalId(record.localId) !== localId
            || !proofAction.success
            || proofAction.data.kind !== params.body.requestedAction.kind
        ) {
            throw new Error('Invalid Pending enqueue terminal proof');
        }
    }
    return {
        didWrite: data && typeof data === 'object' && typeof (data as { didWrite?: unknown }).didWrite === 'boolean'
            ? (data as { didWrite: boolean }).didWrite
            : null,
        terminal,
        suppressed: data && typeof data === 'object' && (data as { suppressed?: unknown }).suppressed === true,
    };
}

export async function resolveAcceptedPendingQueueV2Delivery(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    localId: string;
}): Promise<{ didResolve: boolean; pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    const localId = requirePendingLocalId(params.localId);
    const payload = AcceptedPendingSettlementRequestV1Schema.parse({
        v: 1, sessionId: params.sessionId, localId,
    });
    let raw: unknown;
    try {
        raw = await emitSocketWithAck({
            socket: createAcceptedPendingSettlementAckSocket(params.socket),
            event: ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
            payload,
        });
    } catch (error) {
        if (readErrorCode(error) === 'socket_not_connected' || readErrorCode(error) === 'socket_ack_timeout') {
            throw error;
        }
        throw new PendingQueueAcceptedSettlementAmbiguousError('transport_failure', error);
    }
    const parsedAck = AcceptedPendingSettlementResponseV1Schema.safeParse(raw);
    if (!parsedAck.success) {
        throw new PendingQueueAcceptedSettlementAmbiguousError('malformed_ack', parsedAck.error);
    }
    const ack = parsedAck.data;
    if (!ack.ok) {
        throw new PendingQueueAcceptedSettlementError(
            ack.error,
            ack.error === 'transaction-unavailable' ? ack.retryAfterMs : undefined,
            ack.error === 'transaction-unavailable' ? ack.correlationId : undefined,
        );
    }
    const pendingQueueState = readKnownPendingQueueState(ack);
    const didResolve = ack.didResolve;
    const message = 'message' in ack ? readMaterializedMessageFromAck(ack) : null;
    if ((didResolve || 'message' in ack) && message?.localId !== localId) {
        throw new PendingQueueAcceptedSettlementAmbiguousError(
            'malformed_ack', new Error('Accepted settlement acknowledgement does not prove the requested localId'),
        );
    }
    return {
        didResolve,
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...('message' in ack ? { message } : { message: null }),
    };
}

export async function blockPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}): Promise<{
    pendingQueueState?: KnownPendingQueueState;
    usedLegacySteeringUnavailableFallback?: true;
}> {
    try {
        const { pendingQueueState } = await postPendingQueueV2DeliveryAction({
            ...params,
            action: 'block',
            body: { reason: params.reason },
        });
        return pendingQueueState ? { pendingQueueState } : {};
    } catch (error) {
        if (
            params.reason !== 'conditional_steer_unavailable'
            || !axios.isAxiosError(error)
            || error.response?.status !== 400
        ) {
            throw error;
        }
        const { pendingQueueState } = await postPendingQueueV2DeliveryAction({
            ...params,
            action: 'block',
            body: { reason: 'steering_unavailable' },
        });
        return { ...(pendingQueueState ? { pendingQueueState } : {}), usedLegacySteeringUnavailableFallback: true };
    }
}

/** The transcript message the server committed when it resolved a pending row as manually handled. */
export type PendingQueueV2HandledTranscriptMessage = Readonly<{
    id: string;
    seq: number;
    localId: string;
    deliveryResolution: Readonly<{ v: 1; kind: 'manual_handled' }>;
}>;

function readHandledTranscriptMessage(
    data: Record<string, unknown>,
    localId: string,
): PendingQueueV2HandledTranscriptMessage | null {
    // The route sends a message only when this request resolved the row; otherwise it answers
    // with the current counts alone.
    if (!hasOwn(data, 'message')) return null;
    const message = data.message;
    const record = message && typeof message === 'object' && !Array.isArray(message)
        ? message as Record<string, unknown>
        : null;
    const resolution = record?.deliveryResolution;
    const resolutionRecord = resolution && typeof resolution === 'object' && !Array.isArray(resolution)
        ? resolution as Record<string, unknown>
        : null;
    const id = record ? readNonBlankOpaqueIdentifier(record.id) : null;
    if (
        !record
        || id === null
        || typeof record.seq !== 'number'
        || !Number.isSafeInteger(record.seq)
        || record.seq < 0
        || readPendingLocalId(record.localId) !== localId
        || resolutionRecord?.v !== 1
        || resolutionRecord.kind !== 'manual_handled'
    ) {
        throw createInvalidResponseShapeError('Invalid pending delivery handled resolution message');
    }
    return { id, seq: record.seq, localId, deliveryResolution: { v: 1, kind: 'manual_handled' } };
}

/**
 * What one handled POST established: the committed transcript message when the request resolved
 * the row, or else the queue counts and version with which the server answers a request that
 * resolved nothing.
 */
export type PendingQueueV2HandledResponse =
    | Readonly<{ transcriptMessage: PendingQueueV2HandledTranscriptMessage; pendingQueueState?: KnownPendingQueueState }>
    | Readonly<{ transcriptMessage: null; pendingQueueState: KnownPendingQueueState }>;

/**
 * Posts one manual-handled resolution. The server has no compare-and-set on the row's state, so a
 * caller that needs one must check the row before calling and read it back afterwards.
 */
export async function markPendingQueueV2DeliveryHandled(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueV2HandledResponse> {
    const localId = requirePendingLocalId(params.localId);
    const { pendingQueueState, data } = await postPendingQueueV2DeliveryAction({
        ...params,
        localId,
        action: 'handled',
        body: {},
    });
    const transcriptMessage = readHandledTranscriptMessage(data, localId);
    if (transcriptMessage !== null) {
        return { transcriptMessage, ...(pendingQueueState ? { pendingQueueState } : {}) };
    }
    // The route's answer to a request that resolved nothing always carries all three counts. A
    // success body with neither that nor a message does not show that the row was left unresolved.
    if (!pendingQueueState || !hasOwn(data, 'pendingBlockedCount')) {
        throw createInvalidResponseShapeError('Invalid pending delivery handled response: neither a resolution message nor valid queue counts');
    }
    return { transcriptMessage: null, pendingQueueState };
}

async function postPendingQueueV2DeliveryAction(params: {
    token: string;
    sessionId: string;
    localId: string;
    action: 'block' | 'handled';
    body: Record<string, unknown>;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; data: Record<string, unknown> }> {
    const localId = requirePendingLocalId(params.localId);
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/${encodeURIComponent(localId)}/delivery/${params.action}`,
        params.body,
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
            timeout: 10_000,
        },
    );
    // Handled receipts must tell an unreadable success body apart from a lost connection, so that
    // action marks it with the invalid-response code. Block keeps its plain errors, whose retry
    // classification its runner callers already depend on.
    const unreadableResponse = (message: string): Error => params.action === 'handled'
        ? createInvalidResponseShapeError(message)
        : new Error(message);
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw unreadableResponse(`Invalid pending delivery ${params.action} response`);
    }
    const record = data as Record<string, unknown>;
    if (record.ok !== true) {
        const error = record.error;
        throw unreadableResponse(`Pending delivery ${params.action} failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
        data: record,
    };
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.expectedPendingVersion === 'number'
                    ? { expectedPendingVersion: params.expectedPendingVersion }
                    : typeof params.knownPendingVersion === 'number'
                        ? { pendingVersion: params.knownPendingVersion }
                        : {}),
                ...(typeof params.expectedRuntimeActivityRevision === 'number'
                    ? { expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision }
                    : {}),
                ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
                ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
                    ? { deliveryTiming: params.deliveryTiming }
                    : {}),
                ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object' || Array.isArray(rawAck)) {
            return {
                ok: false,
                error: new PendingQueueMaterializationTransportAmbiguousError(
                    new Error('Invalid pending queue materialize socket acknowledgement'),
                    'malformed_ack',
                ),
            };
        }
        if (rawAck.ok === false) {
            const serverError = readSafePendingMaterializeServerError(rawAck.error);
            if (serverError) {
                const retryAfterMs = serverError === 'transaction-unavailable'
                    ? readPendingMaterializeRetryAfterMs(rawAck)
                    : undefined;
                // With delivery-state opt-in present, the session socket's `forbidden` comes only from
                // the server's session binding or publisher fence: this connection no longer
                // publishes the session, and retrying on it cannot succeed.
                const isPublisherLost = serverError === 'forbidden' && params.deliveryStateOptIn === true;
                return {
                    ok: false,
                    error: new PendingQueueMaterializationTransportAmbiguousError(
                        new Error(`Pending queue materialize server acknowledgement: ${serverError}`),
                        retryAfterMs !== undefined
                            ? 'server_retryable'
                            : isPublisherLost ? 'publisher_lost' : 'server_rejected',
                        serverError,
                        retryAfterMs,
                    ),
                };
            }
        }
        if (rawAck.ok !== true) {
            return {
                ok: false,
                error: new PendingQueueMaterializationTransportAmbiguousError(
                    new Error('Invalid pending queue materialize socket acknowledgement'),
                    'malformed_ack',
                ),
            };
        }
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            const deferredReason = readPendingMaterializeDeferredReason(rawAck);
            const retryAfterMs = readPendingMaterializeRetryAfterMs(rawAck);
            const deliveryState = parseDeliveryState(rawAck.deliveryState).deliveryState;
            return {
                ok: true,
                didMaterialize: false,
                ...(pendingQueueState ? { pendingQueueState } : {}),
                ...(deferredReason ? { deferredReason } : {}),
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                ...(deliveryState ? { deliveryState } : {}),
            };
        }
        const message = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, message);
        const didWrite = rawAck.didWrite === true;
        const didWriteExplicitFalse = rawAck.didWrite === false;
        const providerDeliveryContractInvalid = !isProviderDeliveryMaterializationValid({
                didWrite,
                didWriteExplicitFalse,
                message,
                localId,
                rawMessageRecord: readRawMaterializedMessageRecordFromAck(rawAck),
            });
        const runtimeActivityNotice = readRuntimeActivityNotice(rawAck);
        return { ok: true, didMaterialize: true, localId, didWrite, message: providerDeliveryContractInvalid ? null : message, ...(providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}), ...(pendingQueueState ? { pendingQueueState } : {}), ...(runtimeActivityNotice ? { runtimeActivityNotice } : {}) };
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        return {
            ok: false,
            error: error instanceof PendingQueueMaterializationTransportAmbiguousError
                ? error
                : new PendingQueueMaterializationTransportAmbiguousError(error),
        };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        buildPendingMaterializeBody(params),
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending queue materialize response');
    }
    if (data.ok !== true) {
        throw new Error(`Pending queue materialize failed: ${typeof data.error === 'string' ? data.error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    if (data.didMaterialize !== true) {
        const deferredReason = readPendingMaterializeDeferredReason(data);
        const retryAfterMs = readPendingMaterializeRetryAfterMs(data);
        const deliveryState = parseDeliveryState(data.deliveryState).deliveryState;
        return {
            ok: true,
            didMaterialize: false,
            ...(pendingQueueState ? { pendingQueueState } : {}),
            ...(deferredReason ? { deferredReason } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(deliveryState ? { deliveryState } : {}),
        };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    const didWriteExplicitFalse = data.didWrite === false || data.didWriteMessage === false;
    const runtimeActivityNotice = readRuntimeActivityNotice(data);
    const providerDeliveryContractInvalid = !isProviderDeliveryMaterializationValid({
            didWrite,
            didWriteExplicitFalse,
            message,
            localId,
            rawMessageRecord: readRawMaterializedMessageRecordFromAck(data),
        });
    return {
        ok: true,
        didMaterialize: true,
        localId,
        didWrite,
        message: providerDeliveryContractInvalid ? null : message,
        ...(providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...(runtimeActivityNotice ? { runtimeActivityNotice } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueMaterializeNextResult> {
    const res = await tryMaterializeNextViaHttp({
        ...params,
        deliveryStateOptIn: params.deliveryStateOptIn === true,
    });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
            ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        ...(res.runtimeActivityNotice ? { runtimeActivityNotice: res.runtimeActivityNotice } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageOnReleasedServer(params: Readonly<{
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}>): Promise<ReleasedServerV021MaterializeAck> {
    if (params.socket.connected !== true) {
        throw new Error('Released server pending materialize socket is disconnected');
    }
    const rawAck = await emitSocketWithAck<unknown>({
        socket: createPendingMaterializeAckSocket(params.socket),
        event: 'pending-materialize-next',
        payload: { sid: params.sessionId },
    });
    const ack = parseReleasedServerV021MaterializeAck(rawAck);
    if (!ack) {
        throw new Error('Invalid released server pending materialize acknowledgement');
    }
    return ack;
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket?: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueMaterializeNextResult> {
    // Strict by default: callers that want best-effort suppression must do so explicitly.
    if (params.socket && params.socket.connected !== true) {
        throw new PendingQueueMaterializationTransportAmbiguousError(
            new Error('Selected pending queue materialize socket is disconnected'),
            'socket_disconnected',
        );
    }
    const connectedSocket = params.socket?.connected === true ? params.socket : null;
    const socketRes = connectedSocket
        ? await tryMaterializeNextViaSocket({
            socket: connectedSocket,
            sessionId: params.sessionId,
            expectedPendingVersion: params.expectedPendingVersion,
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision,
            knownPendingVersion: params.knownPendingVersion,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
            foregroundState: params.foregroundState,
        })
        : null;
    let res: PendingQueueSocketMaterializeResult | PendingQueueHttpMaterializeResult;
    if (socketRes?.ok) {
        res = socketRes;
    } else if (connectedSocket) {
        throw socketRes?.error instanceof PendingQueueMaterializationTransportAmbiguousError
            ? socketRes.error
            : new PendingQueueMaterializationTransportAmbiguousError(socketRes?.error);
    } else {
        res = await tryMaterializeNextViaHttp({
            token: params.token,
            sessionId: params.sessionId,
            expectedPendingVersion: params.expectedPendingVersion,
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
            foregroundState: params.foregroundState,
        });
    }
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
            ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        ...(res.runtimeActivityNotice ? { runtimeActivityNotice: res.runtimeActivityNotice } : {}),
    };
}
