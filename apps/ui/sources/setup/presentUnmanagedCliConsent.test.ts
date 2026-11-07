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

import { presentUnmanagedCliConsent } from './presentUnmanagedCliConsent';

describe('presentUnmanagedCliConsent', () => {
    beforeEach(() => {
        confirmSpy.mockClear();
    });

    it('asks once, naming the exact binary, and returns the answer', async () => {
        confirmSpy.mockResolvedValueOnce(false);

        const answer = await presentUnmanagedCliConsent({ cliCommand: '/home/dev/repo/apps/cli/bin/happier.mjs' });

        expect(answer).toBe(false);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        const [title, body] = confirmSpy.mock.calls[0] as unknown as [string, string];
        expect(title).toBe('setupSurface.cliTrustTitle');
        expect(body).toContain('/home/dev/repo/apps/cli/bin/happier.mjs');
    });

    it('still asks, without inventing a path, when the executor named no command', async () => {
        const answer = await presentUnmanagedCliConsent({ cliCommand: null });

        expect(answer).toBe(true);
        const [, body] = confirmSpy.mock.calls[0] as unknown as [string, string];
        expect(body).toBe('setupSurface.cliTrustBodyUnknownCommand');
    });
});
