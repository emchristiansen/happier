import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

import { presentSetupServiceConsent } from './presentSetupServiceConsent';

describe('presentSetupServiceConsent', () => {
    beforeEach(() => {
        confirmSpy.mockClear();
    });

    it('presents the executor facts in one focused confirm and returns the answer', async () => {
        confirmSpy.mockResolvedValueOnce(false);
        const answer = await presentSetupServiceConsent({
            taskId: 'task_1',
            message: 'A pinned service already exists.',
            competingServices: ['pinned'],
            servicesToRemove: ['legacy'],
            takeover: 'Taking over happier-daemon.',
        });

        expect(answer).toBe(false);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        const [title, body] = confirmSpy.mock.calls[0] as unknown as [string, string];
        expect(title).toBe('setupSurface.consentTitle');
        expect(body).toContain('A pinned service already exists.');
        expect(body).toContain('pinned, legacy');
    });

    it('falls back to the generic body when the executor gave no message', async () => {
        await presentSetupServiceConsent({ taskId: 'task_1', message: null, competingServices: [], servicesToRemove: [], takeover: null });
        const [, body] = confirmSpy.mock.calls[0] as unknown as [string, string];
        expect(body).toBe('setupSurface.consentBodyFallback');
    });

    it('asks about taking over a daemon started by hand in the CLI\'s own words, not as a service to replace (U8)', async () => {
        // No service exists: a daemon started from a terminal is running. Saying "a background
        // service already exists" was false, and the CLI's own notice was dropped.
        await presentSetupServiceConsent({
            taskId: 'task_1',
            message: null,
            competingServices: [],
            servicesToRemove: [],
            takeover: 'Stopping the daemon started from a terminal (pid 4242).',
        });
        const [title, body, options] = confirmSpy.mock.calls[0] as unknown as [string, string, { confirmText: string }];
        expect(title).toBe('setupSurface.consentTakeoverTitle');
        expect(body).toBe('Stopping the daemon started from a terminal (pid 4242).');
        expect(options.confirmText).toBe('setupSurface.consentTakeoverConfirm');
    });
});
