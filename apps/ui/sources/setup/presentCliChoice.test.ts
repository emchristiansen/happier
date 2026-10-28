import type { SetupCliChoicePromptPayload } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AlertButton = Readonly<{ text: string; onPress?: () => void }>;

const alertAsyncSpy = vi.hoisted(() => vi.fn(async (_title: string, _body: string | undefined, _buttons?: readonly AlertButton[]) => {}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: alertAsyncSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

import { presentCliChoice } from './presentCliChoice';

const NPM_CLI: SetupCliChoicePromptPayload = {
    command: '/usr/local/bin/happier',
    version: '0.2.13',
    origin: 'npm',
    removalCommand: 'npm uninstall -g @happier-dev/cli',
    updateCommand: 'npm install -g @happier-dev/cli@latest',
    belowSetupFloor: false,
    missing: false,
    keepBlockedBy: null,
};

/** Presses the button whose label is `key` when the alert opens. */
function pressOnOpen(key: string | null): void {
    alertAsyncSpy.mockImplementationOnce(async (_title, _body, buttons) => {
        buttons?.find((button) => button.text === key)?.onPress?.();
    });
}

describe('presentCliChoice (R12)', () => {
    beforeEach(() => {
        alertAsyncSpy.mockClear();
    });

    it('names the CLI it found and returns the answer, or null when dismissed', async () => {
        pressOnOpen('setupSurface.cliChoiceManage');
        await expect(presentCliChoice(NPM_CLI)).resolves.toBe('managed');
        const [title, body] = alertAsyncSpy.mock.calls[0] ?? [];
        expect(title).toContain('0.2.13');
        expect(body).toContain('/usr/local/bin/happier');

        pressOnOpen('setupSurface.cliChoiceKeep');
        await expect(presentCliChoice(NPM_CLI)).resolves.toBe('own');

        pressOnOpen(null);
        await expect(presentCliChoice(NPM_CLI)).resolves.toBeNull();
    });

    it('asks about a kept CLI that disappeared as missing, by the path it was at — never as "already installed" (R13)', async () => {
        const missing = { ...NPM_CLI, version: null, belowSetupFloor: true, missing: true };
        pressOnOpen('setupSurface.cliChoiceManage');

        await expect(presentCliChoice(missing)).resolves.toBe('managed');

        const [title, body] = alertAsyncSpy.mock.calls[0] ?? [];
        expect(title).toBe('setupSurface.cliChoiceTitleMissing');
        expect(body).toBe('setupSurface.cliChoiceBodyMissing:{"path":"/usr/local/bin/happier"}');
    });

    it('does not offer "Keep my own" when the terminal would still run the managed CLI first, and names what keeping it needs (RV3-1)', async () => {
        const shadowed = { ...NPM_CLI, keepBlockedBy: '/home/me/.local/bin/happier' };
        pressOnOpen('setupSurface.cliChoiceKeep');

        await expect(presentCliChoice(shadowed)).resolves.toBeNull();

        const [, body, buttons] = alertAsyncSpy.mock.calls[0] ?? [];
        expect(buttons?.map((button) => button.text)).toEqual(['setupSurface.cliChoiceNotNow', 'setupSurface.cliChoiceManage']);
        expect(body).toBe('setupSurface.cliChoiceBodyKeepBlocked:{"path":"/usr/local/bin/happier","link":"/home/me/.local/bin/happier"}');
    });
});
