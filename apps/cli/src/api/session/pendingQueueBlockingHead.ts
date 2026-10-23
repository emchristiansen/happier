import { readPendingQueueBlockingHeadV1, type PendingQueueBlockingHeadV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

/** A head that stays the same is logged again after this long, so its growing age stays visible. */
export const PENDING_QUEUE_BLOCKING_HEAD_LOG_REPEAT_MS = 5 * 60_000;

/**
 * The blocking head a session record reports: `null` when the server reports none, `undefined` when
 * the record carries no report (an older server) or a report this reader cannot parse.
 */
export function readSessionPendingQueueBlockingHead(record: unknown): PendingQueueBlockingHeadV1 | null | undefined {
    if (!record || typeof record !== 'object') return undefined;
    const value = (record as { pendingQueueBlockingHead?: unknown }).pendingQueueBlockingHead;
    if (value === null) return null;
    if (value === undefined) return undefined;
    return readPendingQueueBlockingHeadV1(value) ?? undefined;
}

export type PendingQueueBlockingHeadReportSource = 'materialize' | 'session_snapshot';

function readHeadKey(head: PendingQueueBlockingHeadV1): string {
    return `${head.localId}\u0000${head.deliveryState}\u0000${head.deliveryState === 'blocked' ? head.blockedReason : ''}`;
}

/**
 * Logs, at info level, the queue head the server reports as holding this session's ordinary pending
 * input back. A wake storm re-reads the same head many times a minute, so a head is logged when it
 * first appears or changes (localId, kind or reason) and again every
 * `PENDING_QUEUE_BLOCKING_HEAD_LOG_REPEAT_MS` while it stays; its clearing is logged once. Logging is
 * all this does: it never acts on the head.
 */
export class PendingQueueBlockingHeadLog {
    private lastKey: string | null = null;
    private lastLoggedAtMs = 0;

    constructor(
        private readonly sessionId: string,
        private readonly nowMs: () => number = Date.now,
    ) {}

    /** `undefined` means the server said nothing about the head; `null` means it reports none. */
    observe(head: PendingQueueBlockingHeadV1 | null | undefined, source: PendingQueueBlockingHeadReportSource): void {
        if (head === undefined) return;
        const now = this.nowMs();
        if (head === null) {
            if (this.lastKey === null) return;
            this.lastKey = null;
            logger.infoFile('[pendingQueue] queue head no longer holds back ordinary pending input', {
                sessionId: this.sessionId,
                source,
            });
            return;
        }
        const key = readHeadKey(head);
        if (key === this.lastKey && now - this.lastLoggedAtMs < PENDING_QUEUE_BLOCKING_HEAD_LOG_REPEAT_MS) return;
        this.lastKey = key;
        this.lastLoggedAtMs = now;
        logger.infoFile('[pendingQueue] queue head holds back ordinary pending input', {
            sessionId: this.sessionId,
            source,
            localId: head.localId,
            deliveryState: head.deliveryState,
            blockedReason: head.deliveryState === 'blocked' ? head.blockedReason : null,
            lastUpdatedAt: head.lastUpdatedAt,
            ageSinceLastUpdateMs: head.ageSinceLastUpdateMs,
        });
    }
}
