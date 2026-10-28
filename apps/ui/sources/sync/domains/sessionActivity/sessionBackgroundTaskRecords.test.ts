import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSystemRecord } from '@happier-dev/protocol';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request } }));
// Transport and session decryption are genuine system boundaries; paging and record parsing stay real.
vi.mock('@/sync/sync', () => ({ sync: { encryption: { getSessionEncryption: () => null } } }));

import { listSessionBackgroundTaskRecords } from './sessionBackgroundTaskRecords';

function record(taskId: string, status: 'running' | 'succeeded'): SessionSystemRecord {
    return {
        id: taskId, sessionId: 'background-record-test', namespace: 'activity', kind: 'background_task.v1',
        localId: `activity:background_task:v1:${taskId}`,
        content: { t: 'plain', v: { v: 1, taskId, kind: 'command', status, updatedAt: 1000 } },
        createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    };
}

describe('background task record inventory', () => {
    beforeEach(() => request.mockReset());

    it('keeps an active task behind the newest finished page', async () => {
        request.mockResolvedValueOnce(new Response(JSON.stringify({
            records: Array.from({ length: 32 }, (_, index) => record(`done-${index}`, 'succeeded')),
            nextCursor: 'older', hasNext: true,
        }))).mockResolvedValueOnce(new Response(JSON.stringify({
            records: [record('still-running', 'running')], nextCursor: null, hasNext: false,
        })));

        const records = await listSessionBackgroundTaskRecords({ sessionId: 'background-record-test' });
        expect(records.some((entry) => entry.taskId === 'done-0')).toBe(true);
        expect(records.find((entry) => entry.taskId === 'still-running')?.status).toBe('running');
    });

    it('does not confuse an unavailable inventory with an authoritative empty one', async () => {
        request.mockResolvedValue(new Response(null, { status: 503 }));
        await expect(listSessionBackgroundTaskRecords({ sessionId: 'background-record-test' })).rejects.toThrow();
        request.mockResolvedValue(new Response(JSON.stringify({ records: [], nextCursor: null, hasNext: false })));
        await expect(listSessionBackgroundTaskRecords({ sessionId: 'background-record-test' })).resolves.toEqual([]);
    });
});
