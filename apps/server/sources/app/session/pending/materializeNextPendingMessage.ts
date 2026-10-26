import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { reofferPendingRowAsNewInTx, reofferRecoverablePendingRowsInTx } from "@/app/session/pending/reofferPendingRowAsNewInTx";
import { type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import {
    inTx,
    isTransactionAcquisitionUnavailableError,
    isTransactionDeadlineExceededError,
    type Tx,
} from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    decideRuntimeIdleAdmission,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    pendingDeliveryStatusV1ToPersistedFields,
    PendingRequestedActionV1Schema,
    readPendingLocalId,
    type PendingProviderAction,
    type PendingRequestedActionV1,
    type SessionMessageRole,
    type SessionPendingQueueDeliveryTiming,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { resolvePendingTranscriptCompatibility } from "@/app/session/pending/pendingMessageTranscriptCommit";
import { logger } from "@/utils/logging/log";
import { readStoredSessionRuntimeActivityProjectionResult } from "@/app/session/runtimeActivity/projection";
import {
    acquireTrustedPendingPublisherAuthority,
    isTrustedPendingPublisherFenceCurrent,
    type TrustedPendingPublisherFence,
} from "@/app/session/pending/pendingPublisherAuthority";
import { reconcilePendingActivationAuthorizationForRemovedRequestInTx } from "@/app/session/pending/pendingActivationAuthorization";

type ParticipantCursor = SessionParticipantCursor;
class PublisherAuthorityLostError extends Error {}

export type PendingMaterializationDeliveryState = Readonly<{
    mode: "provider";
    unresolved: boolean;
}>;

export type PendingMaterializationDeliveryStateMode = PendingMaterializationDeliveryState["mode"];

const pendingMessageEligibleForMaterializationWhere = {
    status: "queued" as const,
    deliveryState: null,
};

type RuntimeActivityPendingDeferredReason =
    | "waiting_for_runtime_activity"
    | "runtime_activity_unknown";

export type PendingForegroundState = "ready" | "active_steerable" | "active_unsteerable";
export type { TrustedPendingPublisherFence } from "@/app/session/pending/pendingPublisherAuthority";

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        pendingStateChanged?: boolean;
        participantCursorsPending?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
        deliveryState?: PendingMaterializationDeliveryState;
        deferredReason?: RuntimeActivityPendingDeferredReason | "waiting_for_foreground_turn" | "pending_version_mismatch" | "waiting_for_predecessor" | "requested_local_id_unavailable";
        retryAfterMs?: number;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: false;
        message: { id: string | null; seq: number | null; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; requestedAction: PendingRequestedActionV1; providerAction: PendingProviderAction; createdAt: Date; updatedAt: Date };
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: boolean;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "requested-action-conflict" | "transcript-conflict" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

async function tryRejoinProviderClaimInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    trustedPublisherFence: TrustedPendingPublisherFence;
    requestedLocalId?: string;
    heldLocalIds?: readonly string[];
    recordChange: (state: Awaited<ReturnType<typeof applyPendingSessionStateChange>>) => void;
}>): Promise<MaterializeNextPendingMessageResult | null> {
        const tx = params.tx;
            const claimed = await tx.sessionPendingMessage.findFirst({
                where: {
                    sessionId: params.sessionId,
                    status: "queued",
                    deliveryState: "delivering",
                    ...(params.requestedLocalId !== undefined || params.heldLocalIds?.length ? {
                        localId: {
                            ...(params.requestedLocalId !== undefined ? { equals: params.requestedLocalId } : {}),
                            ...(params.heldLocalIds?.length ? { notIn: [...params.heldLocalIds] } : {}),
                        },
                    } : {}),
                },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    providerAction: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (!claimed) return null;
            if (readPendingLocalId(claimed.localId) === null) {
                return { ok: false, error: "invalid-params" };
            }
            if (claimed.providerAction === null) {
                params.recordChange(await reofferPendingRowAsNewInTx(tx, params.sessionId, claimed.localId, new Date()));
                return await tryRejoinProviderClaimInTx(params);
            }
            const requestedAction = PendingRequestedActionV1Schema.safeParse(claimed.requestedAction);
            const providerAction = claimed.providerAction;
            if (
                !requestedAction.success
                || (providerAction !== "send" && providerAction !== "steer" && providerAction !== "interrupt_and_send")
            ) return { ok: false, error: "invalid-params" };
            const session = await tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const content = toSessionMessageContentFromPending(
                claimed.content as PrismaJson.SessionPendingMessageContent,
            );
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: claimed.messageRole,
                telemetry: {
                    sessionId: params.sessionId,
                    storageMode: content.t === "plain" ? "plain" : "e2ee",
                    source: "pending-materialization",
                },
            }).messageRole;
            return {
                ok: true,
                didMaterialize: true,
                didWriteMessage: false,
                message: {
                    id: null,
                    seq: null,
                    localId: claimed.localId,
                    messageRole,
                    content,
                    requestedAction: requestedAction.data,
                    providerAction,
                    createdAt: claimed.createdAt,
                    updatedAt: claimed.updatedAt,
                },
                participantCursorsPending: [],
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                deliveryState: { mode: "provider", unresolved: true },
                badgeAttentionChanged: false,
            };
}

export async function materializeNextPendingMessageForCurrentPublisher(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    requestedLocalId?: string;
    trustedPublisherFence: TrustedPendingPublisherFence;
    heldLocalIds?: readonly string[];
    expectedPendingVersion?: number;
    deliveryTiming: SessionPendingQueueDeliveryTiming;
    foregroundState: PendingForegroundState;
    expectedRuntimeActivityRevision?: number;
    deadlineAtMs?: number;
}>): Promise<MaterializeNextPendingMessageResult> {
    try {
        return await inTx(
            async (tx) => await materializeNextPendingMessageForCurrentPublisherInTx({ ...params, tx }),
            params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs },
        );
    } catch (error) {
        return mapPendingMaterializationError(error);
    }
}

export async function materializeNextPendingMessageForCurrentPublisherInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    requestedLocalId?: string;
    trustedPublisherFence: TrustedPendingPublisherFence;
    heldLocalIds?: readonly string[];
    expectedPendingVersion?: number;
    deliveryTiming: SessionPendingQueueDeliveryTiming;
    foregroundState: PendingForegroundState;
    expectedRuntimeActivityRevision?: number;
}>): Promise<MaterializeNextPendingMessageResult> {
    return await materializeNextPendingMessageInTx(params);
}

type MaterializeNextPendingMessageCommonParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    requestedLocalId?: string;
    heldLocalIds?: readonly string[];
    expectedPendingVersion?: number;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: PendingForegroundState;
    expectedRuntimeActivityRevision?: number;
}>;

type MaterializeNextPendingMessageParams =
    MaterializeNextPendingMessageCommonParams
    & Readonly<{ trustedPublisherFence: TrustedPendingPublisherFence }>;

export async function materializeNextPendingMessage(
    params: MaterializeNextPendingMessageParams,
): Promise<MaterializeNextPendingMessageResult> {
    return await materializeNextPendingMessageForCurrentPublisher({
        ...params,
        deliveryTiming: params.deliveryTiming ?? "after_foreground_ready",
        foregroundState: params.foregroundState ?? "ready",
    });
}

export function mapPendingMaterializationError(error: unknown): MaterializeNextPendingMessageResult {
    if (error instanceof PublisherAuthorityLostError) return { ok: false, error: "forbidden" };
    if (isTransactionDeadlineExceededError(error) || isTransactionAcquisitionUnavailableError(error)) {
        return { ok: false, error: "transaction-unavailable", retryAfterMs: 1_000 };
    }
    return { ok: false, error: "internal" };
}

async function materializeNextPendingMessageInTx(
    params: MaterializeNextPendingMessageParams & Readonly<{ tx: Tx }>,
): Promise<MaterializeNextPendingMessageResult> {
    const tx = params.tx;
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const requestedLocalId = params.requestedLocalId === undefined
        ? undefined
        : readPendingLocalId(params.requestedLocalId) ?? "";
    if (params.requestedLocalId !== undefined && !requestedLocalId) {
        return { ok: false, error: "invalid-params" };
    }
    const materializedDeliveryState = {
        mode: "provider",
        unresolved: true,
    } satisfies PendingMaterializationDeliveryState;
    const noopDeliveryState = {
        mode: "provider",
        unresolved: false,
    } satisfies PendingMaterializationDeliveryState;
    const pendingMessageMaterializationWhere = pendingMessageEligibleForMaterializationWhere;
    const foregroundState = params.foregroundState ?? "ready";

    if (!params.trustedPublisherFence) {
        return { ok: false, error: "forbidden" };
    }
    if (!await acquireTrustedPendingPublisherAuthority({
        tx,
        actorUserId,
        sessionId,
        fence: params.trustedPublisherFence,
    })) return { ok: false, error: "forbidden" };
    const changes = await reofferRecoverablePendingRowsInTx({ tx, sessionId, now: new Date() });
    const finish = async (result: MaterializeNextPendingMessageResult): Promise<MaterializeNextPendingMessageResult> => {
        if (!result.ok || changes.length === 0) return result;
        const latest = await tx.session.findUniqueOrThrow({
            where: { id: sessionId }, select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        const cursors = new Map<string, ParticipantCursor>();
        for (const cursor of [...changes.flatMap((change) => change.participantCursors), ...(result.participantCursorsPending ?? [])]) {
            if (cursor.cursor > (cursors.get(cursor.accountId)?.cursor ?? -1)) cursors.set(cursor.accountId, cursor);
        }
        return {
            ...result, ...latest,
            ...(!result.didMaterialize ? { pendingStateChanged: true } : {}),
            participantCursorsPending: [...cursors.values()],
            badgeAttentionChanged: Boolean(result.badgeAttentionChanged) || changes.some((change) => change.badgeAttentionChanged),
        };
    };
    const rejoined = await tryRejoinProviderClaimInTx({
        tx, actorUserId, sessionId,
        trustedPublisherFence: params.trustedPublisherFence,
        ...(requestedLocalId !== undefined ? { requestedLocalId } : {}),
        heldLocalIds: params.heldLocalIds,
        recordChange: (state) => { changes.push(state); },
    });
    if (rejoined !== null) return await finish(rejoined);
    if (
        foregroundState !== "ready"
        && foregroundState !== "active_steerable"
        && foregroundState !== "active_unsteerable"
    ) {
        return { ok: false, error: "invalid-params" };
    }

    if (
        !actorUserId
        || !sessionId
        || (
            params.expectedPendingVersion !== undefined
            && (!Number.isSafeInteger(params.expectedPendingVersion) || params.expectedPendingVersion < 0)
        )
        || (params.requestedLocalId !== undefined && !requestedLocalId)
    ) return { ok: false, error: "invalid-params" };

    // Released claim writers omitted this field and historically meant foreground-ready.
    // Current writers resolve the canonical account preference and send it explicitly.
    const deliveryTiming = params.deliveryTiming ?? "after_foreground_ready";

    const sessionRow = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!sessionRow) return { ok: false, error: "session-not-found" };
    if (requestedLocalId === undefined && (sessionRow.pendingCount ?? 0) <= 0 && params.expectedPendingVersion === undefined) {
        // pendingCount is a denormalized counter; treat it as a fast-path hint, not a source of truth.
        // If the counter is inconsistent (e.g. race/data corruption), fall back to checking the queue.
        const hasEligibleQueued = await tx.sessionPendingMessage.findFirst({
            where: { sessionId, ...pendingMessageMaterializationWhere },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (!hasEligibleQueued) {
            const pendingCount = await tx.sessionPendingMessage.count({
                where: { sessionId, status: "queued" },
            });
            if (pendingCount > 0) {
                // Retained rows exist but none is eligible for the released materializer.
                // Let the transactional path reconcile the aggregate pending counter.
            } else {
                return await finish({
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionRow.pendingCount ?? 0,
                    pendingBlockedCount: sessionRow.pendingBlockedCount ?? 0,
                    pendingVersion: sessionRow.pendingVersion ?? 0,
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                });
            }
        }
    }

    const sessionEncryptionMode: "e2ee" | "plain" = sessionRow.encryptionMode === "plain" ? "plain" : "e2ee";
    const policy = readEncryptionFeatureEnv(process.env);

        let pendingVersionChecked = false;
        const selectAndClaim = async (): Promise<MaterializeNextPendingMessageResult> => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                    runtimeActivityState: true,
                    runtimeActivityActiveCount: true,
                    runtimeActivityObservedAt: true,
                    runtimeActivityRevision: true,
                    updatedAt: true,
                },
            });

            if (
                !await isTrustedPendingPublisherFenceCurrent({
                    tx,
                    actorUserId,
                    sessionId,
                    fence: params.trustedPublisherFence,
                })
            ) {
                return { ok: false, error: "forbidden" } as const;
            }

            if (
                !pendingVersionChecked
                && params.expectedPendingVersion !== undefined
                && sessionBefore.pendingVersion !== params.expectedPendingVersion
            ) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount ?? 0,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                    pendingVersion: sessionBefore.pendingVersion ?? 0,
                    deferredReason: "pending_version_mismatch",
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }

            pendingVersionChecked = true;

            const queuedBeforeRecovery = await tx.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    providerAction: true,
                    status: true,
                    deliveryState: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            const queuedPending: typeof queuedBeforeRecovery = [];
            for (const row of queuedBeforeRecovery) {
                if (row.deliveryState !== null) continue;
                const action = PendingRequestedActionV1Schema.safeParse(row.requestedAction);
                const content = toSessionMessageContentFromPending(row.content as PrismaJson.SessionPendingMessageContent);
                const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
                if (readPendingLocalId(row.localId) === null || !action.success
                    || !isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                    await tx.sessionPendingMessage.update({
                        where: { sessionId_localId: { sessionId, localId: row.localId } },
                        data: { deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
                    });
                    const pendingBlockedCount = await tx.sessionPendingMessage.count({ where: { sessionId, status: "queued", deliveryState: "blocked" } });
                    const before = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { pendingBlockedCount: true } });
                    changes.push(await applyPendingSessionStateChange({ tx, sessionId, pendingBlockedCountDelta: pendingBlockedCount - before.pendingBlockedCount }));
                    continue;
                }
                queuedPending.push(row);
            }
            const queueHead = queuedPending[0];
            const exactActionCandidate = queuedPending.find((row) => {
                if (requestedLocalId !== undefined && row.localId !== requestedLocalId) return false;
                if (row.deliveryState !== null) return false;
                const action = PendingRequestedActionV1Schema.safeParse(row.requestedAction);
                if (!action.success) return false;
                if (requestedLocalId !== undefined && action.data.kind !== "steer_now" && action.data.kind !== "steer_now_bound") return false;
                return action.data.kind === "send_now"
                    || action.data.kind === "steer_now"
                    || action.data.kind === "steer_now_bound"
                    || (
                        action.data.kind === "steer_if_active"
                        && foregroundState === "active_steerable"
                    );
            });

            if (!queueHead) {
                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued" },
                });
                const blockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
                });
                if ((sessionBefore.pendingCount ?? 0) !== pendingCount || (sessionBefore.pendingBlockedCount ?? 0) !== blockedCount) {
                    const repaired = await tx.session.updateMany({
                        where: {
                            id: sessionId,
                            pendingCount: sessionBefore.pendingCount,
                            pendingBlockedCount: sessionBefore.pendingBlockedCount,
                            pendingVersion: sessionBefore.pendingVersion,
                        },
                        data: { pendingCount, pendingBlockedCount: blockedCount, pendingVersion: { increment: 1 } },
                    });
                    const latestSession = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    if (repaired.count > 0) {
                        const participantCursors = await markPendingStateChangedParticipants({
                            tx,
                            sessionId,
                            pendingVersion: latestSession.pendingVersion,
                            pendingCount: latestSession.pendingCount,
                            pendingBlockedCount: latestSession.pendingBlockedCount,
                        });
                        changes.push({
                            ...latestSession,
                            participantCursors,
                            badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                                sessionBefore,
                                { ...sessionBefore, ...latestSession },
                            ),
                        });
                    }
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: latestSession.pendingCount,
                        pendingBlockedCount: latestSession.pendingBlockedCount,
                        pendingVersion: latestSession.pendingVersion,
                        ...(requestedLocalId !== undefined ? { deferredReason: "requested_local_id_unavailable" as const } : {}),
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }

                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount ?? 0,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                    pendingVersion: sessionBefore.pendingVersion ?? 0,
                    ...(requestedLocalId !== undefined ? { deferredReason: "requested_local_id_unavailable" as const } : {}),
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }
            if (readPendingLocalId(queueHead.localId) === null) {
                return { ok: false, error: "invalid-params" } as const;
            }

            if (requestedLocalId !== undefined && !exactActionCandidate) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount ?? 0,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                    pendingVersion: sessionBefore.pendingVersion ?? 0,
                    deferredReason: "requested_local_id_unavailable",
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }

            const selectedAction = exactActionCandidate
                ? PendingRequestedActionV1Schema.safeParse(exactActionCandidate.requestedAction)
                : null;
            if (selectedAction && !selectedAction.success) {
                return { ok: false, error: "invalid-params" } as const;
            }
            // Automatic delivery picks the first eligible row; retained claims and blocks hold nothing.
            // Explicit actions may still bypass ordinary enqueue input.
            let selected: { row: NonNullable<typeof queueHead>; action: PendingRequestedActionV1 } | undefined;
            if (exactActionCandidate && selectedAction?.success) {
                selected = { row: exactActionCandidate, action: selectedAction.data };
            } else {
                const headAction = PendingRequestedActionV1Schema.safeParse(queueHead.requestedAction);
                if (!headAction.success) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                if (foregroundState === "ready") {
                    selected = { row: queueHead, action: headAction.data };
                }
            }
            if (!selected) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount ?? 0,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                    pendingVersion: sessionBefore.pendingVersion ?? 0,
                    deferredReason: "waiting_for_foreground_turn",
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }

            const nextPending = selected.row;
            const requestedAction = selected.action;
            const providerAction: PendingProviderAction = requestedAction.kind === "steer_now"
                || requestedAction.kind === "steer_now_bound"
                || (requestedAction.kind === "steer_if_active" && foregroundState === "active_steerable")
                ? "steer"
                : requestedAction.kind === "send_now" && foregroundState !== "ready"
                    ? "interrupt_and_send"
                    : "send";
            const consumesRuntimeActivity = deliveryTiming === "after_runtime_idle" && (
                requestedAction.kind === "enqueue"
                || (requestedAction.kind === "steer_if_active" && foregroundState !== "active_steerable")
            );
            if (consumesRuntimeActivity) {
                const activityRead = readStoredSessionRuntimeActivityProjectionResult(sessionBefore);
                const activityDecision = activityRead.status === "valid"
                    ? decideRuntimeIdleAdmission(activityRead.projection)
                    : { decision: "defer" as const, reason: "unknown" as const };
                if (activityDecision.decision === "defer") {
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: sessionBefore.pendingCount ?? 0,
                        pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                        pendingVersion: sessionBefore.pendingVersion ?? 0,
                        deferredReason: activityDecision.reason === "active"
                            ? "waiting_for_runtime_activity"
                            : "runtime_activity_unknown",
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }
                if (
                    !Number.isSafeInteger(params.expectedRuntimeActivityRevision)
                    || params.expectedRuntimeActivityRevision !== activityDecision.revision
                ) {
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: sessionBefore.pendingCount ?? 0,
                        pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                        pendingVersion: sessionBefore.pendingVersion ?? 0,
                        deferredReason: "runtime_activity_unknown",
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }
            }

            const localId = nextPending.localId;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: nextPending.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-materialization",
                },
            }).messageRole;

            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return { ok: false, error: "invalid-params" } as const;
            }

            {
                const existingTranscriptMessage = await tx.sessionMessage.findFirst({
                    where: { sessionId, localId },
                    select: { content: true, messageRole: true },
                });
                if (existingTranscriptMessage) {
                    const compatibility = resolvePendingTranscriptCompatibility({
                        existing: existingTranscriptMessage,
                        pending: { content, messageRole },
                    });
                    if (!compatibility.ok) {
                        changes.push(await reofferPendingRowAsNewInTx(tx, sessionId, localId, new Date()));
                        return await selectAndClaim();
                    }
                }

                const delivering = pendingDeliveryStatusV1ToPersistedFields({ status: "delivering" });
                const claimed = await tx.sessionPendingMessage.updateMany({
                    where: {
                        sessionId,
                        localId,
                        ...pendingMessageMaterializationWhere,
                        providerAction: null,
                    },
                    data: {
                        deliveryState: delivering.deliveryState,
                        deliveryBlockedReason: delivering.deliveryBlockedReason,
                        providerAction,
                    },
                });
                if (claimed.count === 0) {
                    const latestSession = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: latestSession.pendingCount,
                        pendingBlockedCount: latestSession.pendingBlockedCount,
                        pendingVersion: latestSession.pendingVersion,
                        ...(requestedLocalId !== undefined ? { deferredReason: "requested_local_id_unavailable" as const } : {}),
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }

                const activationTarget = await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
                    tx,
                    sessionId,
                    requestId: localId,
                });

                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued" },
                });
                const pendingBlockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
                });
                const sessionSelect = {
                    seq: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                } as const;
                const sessionFence = await tx.session.updateMany({
                    where: {
                        id: sessionId,
                        active: true,
                        archivedAt: null,
                        lastActiveAt: params.trustedPublisherFence.committedFence,
                        ...(consumesRuntimeActivity
                            ? { runtimeActivityRevision: BigInt(params.expectedRuntimeActivityRevision!) }
                            : {}),
                    },
                    data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                });
                if (sessionFence.count !== 1) throw new PublisherAuthorityLostError();
                const session = await tx.session.findUniqueOrThrow({
                    where: { id: sessionId },
                    select: sessionSelect,
                });

                const participantCursorsPending = await markPendingStateChangedParticipants({
                    tx,
                    sessionId,
                    pendingVersion: session.pendingVersion,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    activationTarget,
                });

                return {
                    ok: true,
                    didMaterialize: true,
                    didWriteMessage: false,
                    message: {
                        id: null,
                        seq: null,
                        localId,
                        messageRole,
                        content,
                        requestedAction,
                        providerAction,
                        createdAt: nextPending.createdAt,
                        updatedAt: nextPending.updatedAt,
                    },
                    participantCursorsPending,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    ...(activationTarget ? { activationTarget } : {}),
                    deliveryState: materializedDeliveryState,
                    badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                        sessionBefore,
                        {
                            seq: session.seq,
                            pendingCount: session.pendingCount,
                            pendingBlockedCount: session.pendingBlockedCount,
                            lastViewedSessionSeq: session.lastViewedSessionSeq,
                            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                            active: session.active,
                            archivedAt: session.archivedAt,
                        },
                    ),
                } as const;
            }

        };
        const result = await selectAndClaim();
        if (result.ok && result.didMaterialize) {
            logger.debug({
                sessionId,
                didMaterialize: true,
                localId: result.message.localId,
                messageSeq: result.message.seq,
                messageRole: result.message.messageRole,
                didWriteMessage: result.didWriteMessage,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
            }, "session.pending.materialize");
        }
        return await finish(result);
}
