import { createHash } from "node:crypto";

import { normalizePendingDeliveryBlockedReason, PENDING_DELIVERY_REOFFER_TIER } from "@happier-dev/protocol";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { armPendingActivationAuthorizationInTx, mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { afterTx, type Tx } from "@/storage/inTx";
import { logger } from "@/utils/logging/log";

export function derivePendingSendAsNewLocalId(sessionId: string, localId: string): string {
    const digest = createHash("sha256")
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0${localId}`, "utf8")
        .digest("hex");
    return `send-as-new-${digest}`;
}

/** Replaces one live row atomically; all callers share the same enqueue-only recovery. */
export async function reofferPendingRowAsNewInTx(tx: Tx, sessionId: string, localId: string, now: Date) {
    const existing = await tx.sessionPendingMessage.findUniqueOrThrow({
        where: { sessionId_localId: { sessionId, localId } },
    });
    if (existing.status !== "queued") throw new Error("pending reoffer requires a live row");
    const replacementLocalId = derivePendingSendAsNewLocalId(sessionId, localId);
    const position = await reserveNextPendingQueuePosition(tx, sessionId);
    await tx.sessionPendingMessage.create({
        data: {
            sessionId,
            localId: replacementLocalId,
            messageRole: existing.messageRole,
            content: existing.content as PrismaJson.SessionPendingMessageContent,
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            providerAction: null,
            position,
            authorAccountId: existing.authorAccountId,
            createdAt: now,
            updatedAt: now,
        },
    });
    await tx.sessionPendingMessage.update({
        where: { sessionId_localId: { sessionId, localId } },
        data: {
            status: "discarded",
            deliveryState: null,
            deliveryBlockedReason: null,
            discardedAt: now,
            discardedReason: "resent_as_new",
        },
    });
    const authorization = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            lastActiveAt: true,
            pendingActivationRequestId: true,
            pendingActivationRequestedAt: true,
            pendingActivationStatus: true,
            pendingActivationFailureCode: true,
        },
    });
    const activationTarget = authorization.pendingActivationRequestId === localId
        && mapPendingActivationAuthorization(authorization)
        ? await armPendingActivationAuthorizationInTx({
            tx, sessionId, requestId: replacementLocalId, now, resumeWhenAvailable: true,
        })
        : undefined;
    const state = await applyPendingSessionStateChange({
        tx, sessionId,
        pendingBlockedCountDelta: existing.deliveryState === "blocked" ? -1 : 0,
        activationTarget,
    });
    afterTx(tx, () => logger.info({ module: "session-pending", sessionId, localId, replacementLocalId }, "session.pending.reoffer"));
    return { ...state, ...(activationTarget ? { activationTarget } : {}) };
}

function pendingReofferDelayMs(): number {
    const raw = process.env.HAPPIER_PENDING_REOFFER_DELAY_MS;
    if (raw === undefined || raw.trim() === "") return 60_000;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : 60_000;
}

/** Turnover also recovers inherited claims. Ordinary materialization never steals live custody. */
export async function reofferRecoverablePendingRowsInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    now: Date;
    includeInheritedClaims?: boolean;
}>) {
    const rows = await params.tx.sessionPendingMessage.findMany({
        where: {
            sessionId: params.sessionId,
            status: "queued",
            deliveryState: { in: params.includeInheritedClaims ? ["delivering", "blocked", "external_handoff"] : ["blocked", "external_handoff"] },
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
        select: { localId: true, deliveryState: true, deliveryBlockedReason: true, updatedAt: true },
    });
    const changes: Awaited<ReturnType<typeof reofferPendingRowAsNewInTx>>[] = [];
    const delayMs = pendingReofferDelayMs();
    for (const row of rows) {
        const reason = normalizePendingDeliveryBlockedReason(row.deliveryBlockedReason) ?? "unknown";
        const tier = row.deliveryState === "delivering" ? "immediate"
            : row.deliveryState === "external_handoff" ? "delayed"
                : PENDING_DELIVERY_REOFFER_TIER[reason];
        if (tier === "immediate" || (tier === "delayed" && params.now.getTime() - row.updatedAt.getTime() >= delayMs)) {
            changes.push(await reofferPendingRowAsNewInTx(params.tx, params.sessionId, row.localId, params.now));
        }
    }
    return changes;
}
