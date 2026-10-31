import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import type { UpdateItem } from '@/updates/items/updateItem';

import { describeUpdateItem } from './describeUpdateItem';

const remoteCli: UpdateItem = {
    id: 'studio:happier-cli',
    subject: { kind: 'happier-cli' },
    machineId: 'studio',
    title: 'Happier CLI',
    currentVersion: '0.2.12',
    latestVersion: '0.2.14',
    state: 'available',
    progressPercent: null,
    step: null,
    managedBy: 'happier',
    action: { kind: 'run', verb: 'update' },
    failure: null,
    skipped: false,
};

describe('describeUpdateItem — the running-sessions fact is a quiet note, never a question', () => {
    it('notes the service restart on a remote Happier CLI row only while sessions run there', () => {
        expect(describeUpdateItem(remoteCli, { sessionsRunning: true }).note).toBe('updates.row.restartsService');
        expect(describeUpdateItem(remoteCli, { sessionsRunning: false }).note).toBeNull();
        expect(describeUpdateItem({ ...remoteCli, id: 'studio:agent:codex', subject: { kind: 'agent-cli', agentId: 'codex' } }, { sessionsRunning: true }).note).toBeNull();
    });
});

describe('describeUpdateItem — already current', () => {
    it('says "Already up to date", never a failure', () => {
        const item: UpdateItem = { ...remoteCli, id: 'studio:agent:claude', subject: { kind: 'agent-cli', agentId: 'claude' }, state: 'upToDate', action: { kind: 'none' }, alreadyCurrent: true };
        expect(describeUpdateItem(item).subtitle).toBe('updates.row.alreadyCurrent');
    });
});
