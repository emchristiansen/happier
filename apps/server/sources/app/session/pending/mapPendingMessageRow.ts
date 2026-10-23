import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    normalizePendingDeliveryStatusV1,
    PendingRequestedActionV1Schema,
    type PendingRequestedActionV1,
    type PendingDeliveryStatusV1,
} from "@happier-dev/protocol";

export type PendingMessageRow = {
    localId: string;
    messageRole: import("@happier-dev/protocol").SessionMessageRole | null;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: PendingRequestedActionV1;
    requestedActionMalformed?: true;
    status: "queued" | "discarded";
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    deliveryStatus: PendingDeliveryStatusV1;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export type PendingMessageRowRaw = {
    localId: string;
    messageRole?: unknown;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction?: unknown;
    status: "queued" | "discarded";
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

/**
 * The server's delivery status for a pending row: the persisted fields, except that a queued row
 * whose requested action this server cannot parse reads as blocked `unsupported_action`, because no
 * runner can ever deliver it. A missing requested action reads as the legacy `enqueue`.
 */
export function readPendingMessageRowDeliveryStatus(row: Readonly<{
    status: string;
    requestedAction?: unknown;
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>): PendingDeliveryStatusV1 {
    return readPendingMessageRowProjection(row).deliveryStatus;
}

function readPendingMessageRowProjection(row: Readonly<{
    status: string;
    requestedAction?: unknown;
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>) {
    const parsedRequestedAction = row.requestedAction == null
        ? PendingRequestedActionV1Schema.safeParse({ v: 1, kind: "enqueue" })
        : PendingRequestedActionV1Schema.safeParse(row.requestedAction);
    const requestedActionMalformed = !parsedRequestedAction.success;
    const deliveryStatus: PendingDeliveryStatusV1 = requestedActionMalformed && row.status !== "discarded"
        ? { status: "blocked", reason: "unsupported_action" }
        : normalizePendingDeliveryStatusV1({
            status: row.status,
            deliveryState: row.deliveryState,
            deliveryBlockedReason: row.deliveryBlockedReason,
            discardedReason: row.discardedReason,
        });
    return {
        requestedAction: parsedRequestedAction.success ? parsedRequestedAction.data : null,
        deliveryStatus,
    };
}

export function mapPendingMessageRow(row: PendingMessageRowRaw): PendingMessageRow {
    const projection = readPendingMessageRowProjection(row);
    const requestedActionMalformed = projection.requestedAction === null;
    return {
        localId: row.localId,
        messageRole: parseSessionMessageRole(row.messageRole),
        content: row.content,
        ...(projection.requestedAction ? { requestedAction: projection.requestedAction } : {}),
        ...(requestedActionMalformed ? { requestedActionMalformed: true as const } : {}),
        status: row.status,
        deliveryState: typeof row.deliveryState === "string" && row.deliveryState.length > 0 ? row.deliveryState : null,
        deliveryBlockedReason: typeof row.deliveryBlockedReason === "string" && row.deliveryBlockedReason.length > 0 ? row.deliveryBlockedReason : null,
        deliveryStatus: projection.deliveryStatus,
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}
