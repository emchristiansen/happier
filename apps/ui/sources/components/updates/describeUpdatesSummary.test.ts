import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';

import { describeUpdatesHeader } from './describeUpdatesSummary';

function summary(overrides: Partial<UpdatesSummary>): UpdatesSummary {
    return { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false, ...overrides };
}

const CHECKED = Date.now() - 60_000;

describe('describeUpdatesHeader (one header per summary state)', () => {
    it('available: the count, and Update all only when there are two or more', () => {
        expect(describeUpdatesHeader(summary({ actionableCount: 3, phase: 'available', status: 'available' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 }))
            .toMatchObject({ title: 'updates.summary.available:{"count":3}', showUpdateAll: true, empty: false });
        expect(describeUpdatesHeader(summary({ actionableCount: 1, phase: 'available', status: 'available' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 }).showUpdateAll).toBe(false);
    });

    it('updating: says so, and Update all goes away (it cannot be pressed)', () => {
        const running = describeUpdatesHeader(summary({ runningCount: 1, phase: 'running', status: 'running' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 });
        expect(running).toMatchObject({ title: 'updates.summary.updating', meta: 'updates.summary.keepWorking', showUpdateAll: false });
        const batch = describeUpdatesHeader(summary({ actionableCount: 2, phase: 'available', status: 'available' }), { done: 1, total: 3, stopping: false }, { checkedAt: CHECKED, uncheckedMachineCount: 0 });
        expect(batch).toMatchObject({ title: 'updates.summary.updatingBatch:{"done":1,"total":3}', showUpdateAll: false, showStop: true });
    });

    it('failed: names how many did not finish, never "Updating…"', () => {
        expect(describeUpdatesHeader(summary({ failedCount: 1, actionableCount: 3, phase: 'failed', status: 'failed' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 }))
            .toMatchObject({ title: 'updates.summary.failedCount:{"count":1}', showUpdateAll: true });
    });

    it('ready: asks for the restart', () => {
        expect(describeUpdatesHeader(summary({ phase: 'ready', status: 'ready', visible: true }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 }).title).toBe('updates.summary.ready');
    });

    it('nothing to take but not proven current: says what is unknown or offline, never "up to date"', () => {
        expect(describeUpdatesHeader(summary({ status: 'offline' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 })).toMatchObject({ title: 'updates.summary.offline', empty: false });
        expect(describeUpdatesHeader(summary({ status: 'unknown' }), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 })).toMatchObject({ title: 'updates.summary.unknown', empty: false });
    });

    it('all up to date: the calm empty state', () => {
        expect(describeUpdatesHeader(summary({}), null, { checkedAt: CHECKED, uncheckedMachineCount: 0 })).toMatchObject({ title: 'updates.summary.upToDate', empty: true });
    });

    it('the header line under a result says when things were checked, or which were not, never both', () => {
        const failed = summary({ failedCount: 3, phase: 'failed', status: 'failed', visible: true });
        expect(describeUpdatesHeader(failed, null, { checkedAt: CHECKED, uncheckedMachineCount: 0 }).meta).toMatch(/^updates\.summary\.checkedAt/);
        expect(describeUpdatesHeader(failed, null, { checkedAt: CHECKED, uncheckedMachineCount: 1 }).meta).toBe('updates.summary.uncheckedMeta');
        expect(describeUpdatesHeader(failed, null, { checkedAt: null, uncheckedMachineCount: 0 }).meta).toBe('updates.summary.notCheckedYet');
    });
});
