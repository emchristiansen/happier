import { normalizePendingDeliveryStatusV1, type PendingQueueBlockingHeadV1 } from "@happier-dev/protocol";

import { readPendingMessageRowDeliveryStatus } from "@/app/session/pending/mapPendingMessageRow";
import { db } from "@/storage/db";

/** The queued-row fields that decide which head holds ordinary rows back. */
export type PendingQueueHeadRow = Readonly<{
    localId: string;
    status: string;
    requestedAction: unknown;
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    updatedAt: Date;
}>;

/** Queue order the materializer uses: oldest position first. */
export const pendingQueueHeadOrderBy = [
    { position: "asc" as const },
    { createdAt: "asc" as const },
    { localId: "asc" as const },
];

/**
 * True for a queued row no runner can ever deliver because this server cannot parse its requested
 * action, in either of its two stored forms:
 * - stored as blocked `unsupported_action` (a runner settled it so);
 * - stored as plain queued with an unparseable action, which the server already reports to every
 *   reader as blocked `unsupported_action` (`readPendingMessageRowDeliveryStatus`).
 * Ordinary rows pass such a row. Any other blocked reason, and delivering or external-handoff rows,
 * keep ordinary rows waiting, whatever their stored action.
 */
export function isPendingRowUndeliverableUnsupportedAction(row: PendingQueueHeadRow): boolean {
    if (row.deliveryState === "blocked") return row.deliveryBlockedReason === "unsupported_action";
    if (row.deliveryState !== null) return false;
    const projected = readPendingMessageRowDeliveryStatus(row);
    return projected.status === "blocked" && projected.reason === "unsupported_action";
}

/**
 * Splits queued rows (in queue order) into the leading rows ordinary delivery passes, and the head
 * ordinary delivery is decided by: the first row that is not an undeliverable unsupported action.
 */
export function splitPendingQueueHead<T extends PendingQueueHeadRow>(rows: readonly T[]): Readonly<{
    passedUnsupported: readonly T[];
    head: T | undefined;
}> {
    let index = 0;
    while (index < rows.length && isPendingRowUndeliverableUnsupportedAction(rows[index]!)) index += 1;
    return { passedUnsupported: rows.slice(0, index), head: rows[index] };
}

/**
 * The report for a head that holds ordinary rows back, or null when the head is deliverable (no
 * delivery state) or absent. Age is measured from the row's last update: rows record no instant at
 * which they became blocked.
 */
export function describePendingQueueBlockingHead(
    head: PendingQueueHeadRow | undefined,
    nowMs: number,
): PendingQueueBlockingHeadV1 | null {
    if (!head || head.deliveryState === null) return null;
    const lastUpdatedAt = head.updatedAt.getTime();
    const common = {
        localId: head.localId,
        lastUpdatedAt,
        ageSinceLastUpdateMs: Math.max(0, nowMs - lastUpdatedAt),
    };
    // The stored fields, not the action-parse override: they say why the head is held.
    const status = normalizePendingDeliveryStatusV1(head);
    switch (status.status) {
        case "blocked":
            return { ...common, deliveryState: "blocked", blockedReason: status.reason };
        case "delivering":
            return { ...common, deliveryState: "delivering" };
        case "external_handoff":
            return { ...common, deliveryState: "external_handoff" };
        default:
            // A queued row with a delivery state the protocol does not know: the materializer
            // still waits behind it, so report it as blocked for an unknown reason.
            return { ...common, deliveryState: "blocked", blockedReason: "unknown" };
    }
}

/** Reads the head that holds a session's ordinary pending rows back, for session state. Read-only. */
export async function readPendingQueueBlockingHead(params: Readonly<{
    sessionId: string;
    nowMs: number;
}>): Promise<PendingQueueBlockingHeadV1 | null> {
    const rows = await db.sessionPendingMessage.findMany({
        where: { sessionId: params.sessionId, status: "queued" },
        orderBy: pendingQueueHeadOrderBy,
        select: {
            localId: true,
            status: true,
            requestedAction: true,
            deliveryState: true,
            deliveryBlockedReason: true,
            updatedAt: true,
        },
    });
    return describePendingQueueBlockingHead(splitPendingQueueHead(rows).head, params.nowMs);
}
