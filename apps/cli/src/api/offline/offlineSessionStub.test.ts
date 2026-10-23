import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from '@/api/offline/offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('returns an EventEmitter-compatible ApiSessionClient', () => {
        const session = createOfflineSessionStub('tag');

        let calls = 0;
        session.on('message', () => {
            calls += 1;
        });
        session.emit('message', { ok: true });

        expect(calls).toBe(1);
    });

    it('implements the session transport surface used while offline', async () => {
        const session = createOfflineSessionStub('tag');

        expect(session.getMetadataSnapshot()).toBeNull();
        await expect(session.ensureMetadataSnapshot()).resolves.toBeNull();
        await expect(session.refreshSessionSnapshotFromServerBestEffort()).resolves.toBeUndefined();
        await expect(session.listPendingMessageQueueV2LocalIds()).resolves.toEqual([]);
        await expect(session.listActionablePendingMessageQueueV2LocalIds()).resolves.toEqual([]);
        await expect(session.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'force' })).resolves.toBe(0);
        await expect(session.fetchCommittedClaudeJsonlMessageBaseline?.({ take: 1 })).resolves.toEqual({ keys: new Set(), complete: true, oldestCoveredAtMs: null });
        await expect(session.fetchRecentTranscriptTextItemsForAcpImport?.({ take: 1 })).resolves.toEqual([]);
        await expect(session.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(0);
        await expect(session.discardCommittedMessageLocalIds({ localIds: ['l1'], reason: 'manual' })).resolves.toBe(0);
        await expect(session.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'deferred', reason: 'supervisor_offline' });
        await expect(session.getCommittedUserMessageSeq('l1')).toBeNull();
        await expect(session.waitForCommittedUserMessageSeq('l1')).resolves.toBeNull();
    });

    it('reports committed transcript writes as unavailable instead of claiming durability', async () => {
        const session = createOfflineSessionStub('tag');

        await expect(session.sendAgentMessageCommitted(
            'gemini',
            { type: 'message', message: 'retained until attachment' },
            { localId: 'offline-segment-1' },
        )).rejects.toThrow(/offline.*not.*persist/i);
    });
});
