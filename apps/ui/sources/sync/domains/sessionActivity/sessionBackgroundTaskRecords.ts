import {
    SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
    SessionBackgroundTaskRecordV1Schema,
    type SessionBackgroundTaskRecordV1,
    type SessionSystemRecord,
} from '@happier-dev/protocol';

import { listSessionSystemRecords } from '@/sync/ops/sessionSystemRecords';

import { openSessionActivityRecordPayload } from './sessionActivityRecordContent';

/**
 * UI read path for the durable `activity/background_task.v1` records the CLI publishes (R-9).
 *
 * Unlike its `workflow_run.v1` sibling, this family is **listed, not looked up**: there is no
 * headline naming which background tasks exist, so the records themselves are the roster. That is
 * the honest shape — the CLI's in-memory ledger owns liveness and is rebuildable, and only the
 * outcome is durable (PLAN §4.9) — and it is why the count and the roster come from different
 * places: the count is the live projection on the session, the rows are these records.
 *
 * Follow the transport's continuation so an old active task is not hidden by newer finished work.
 * An unavailable page or payload rejects the refresh, preserving the caller's last-known inventory.
 */

/** Open one record's envelope and validate it, or `null` when it is not a well-formed task record. */
export async function openBackgroundTaskSystemRecord(params: Readonly<{
    sessionId: string;
    record: SessionSystemRecord | null;
}>): Promise<SessionBackgroundTaskRecordV1 | null> {
    const record = params.record;
    if (!record) return null;
    if (record.namespace !== SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE) return null;
    if (record.kind !== 'background_task.v1') return null;
    const payload = await openSessionActivityRecordPayload({
        sessionId: params.sessionId,
        content: record.content,
    });
    if (payload === null || payload === undefined) return null;
    const parsed = SessionBackgroundTaskRecordV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

/**
 * Every background task this session has a durable record for, newest first.
 *
 * An old CLI that never writes these records produces an authoritative empty inventory.
 */
export async function listSessionBackgroundTaskRecords(params: Readonly<{
    sessionId: string;
    limit?: number;
    serverId?: string | null;
}>): Promise<readonly SessionBackgroundTaskRecordV1[]> {
    const records: SessionBackgroundTaskRecordV1[] = [];
    let cursor: string | null = null;
    do {
        const page = await listSessionSystemRecords({
            sessionId: params.sessionId,
            namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
            kind: 'background_task.v1',
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            cursor,
            ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
        });
        const opened = await Promise.all(page.records.map(
            (record) => openBackgroundTaskSystemRecord({ sessionId: params.sessionId, record }),
        ));
        for (const record of opened) {
            if (!record) throw new Error('Background task record unavailable');
            records.push(record);
        }
        cursor = page.hasNext ? page.nextCursor : null;
        if (page.hasNext && cursor === null) throw new Error('Background task inventory continuation unavailable');
    } while (cursor !== null);
    return records;
}
