import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlertButton } from '@/modal';

const alertAsyncSpy = vi.hoisted(() => vi.fn(async () => {}));

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

import { presentRelayReconciliationConsent } from './presentRelayReconciliationConsent';

const RELAY_MOVE = { kind: 'relay', fromRelayHost: 'self.example.test', toRelayHost: 'new.example.test' } as const;
const ACCOUNT_MOVE = {
    kind: 'account',
    fromAccountLabel: 'bob',
    toAccountLabel: 'alice',
    relayHost: 'new.example.test',
    fromRelayHost: null,
} as const;

function pressButtonLabelled(label: string): void {
    const buttons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2];
    const button = buttons.find((entry) => entry.text === label);
    expect(button).toBeTruthy();
    button?.onPress?.();
}

describe('presentRelayReconciliationConsent (UD5)', () => {
    beforeEach(() => {
        alertAsyncSpy.mockClear();
    });

    it('names both relay hosts and returns the answer the user chose (U2)', async () => {
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveConfirm');
        });

        await expect(presentRelayReconciliationConsent(RELAY_MOVE)).resolves.toBe('move');
        const [title, body] = alertAsyncSpy.mock.calls[0] as unknown as [string, string];
        expect(title).toBe('setupSurface.relayMoveTitle');
        expect(body).toContain('self.example.test');
        expect(body).toContain('new.example.test');
    });

    it('asks an account move in its own words, naming both accounts, with no "always" (D1/U2)', async () => {
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.accountMoveConfirm');
        });

        await expect(presentRelayReconciliationConsent(ACCOUNT_MOVE)).resolves.toBe('move');
        const [title, body, buttons] = alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]];
        expect(title).toContain('setupSurface.accountMoveTitle');
        expect(body).toContain('bob');
        expect(body).toContain('alice');
        expect(buttons.map((entry) => entry.text)).toEqual([
            'setupSurface.relayMoveKeep',
            'setupSurface.accountMoveConfirm',
        ]);
    });

    it('returns "always" only for the remember-this-device choice', async () => {
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveAlways');
        });

        await expect(presentRelayReconciliationConsent(RELAY_MOVE)).resolves.toBe('always');
    });

    it('keeps the service where it is when the alert is dismissed without a choice', async () => {
        await expect(presentRelayReconciliationConsent(RELAY_MOVE)).resolves.toBe('keep');
    });

    it('asks about moving the relay in its own words, never the service-replacement copy', async () => {
        // "Replace it" / "Keep the existing service" belong to the executor's ownership consent,
        // which is a different question about a different object.
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveKeep');
        });

        await expect(presentRelayReconciliationConsent(RELAY_MOVE)).resolves.toBe('keep');
        const buttons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2];
        expect(buttons.map((entry) => entry.text)).toEqual([
            'setupSurface.relayMoveKeep',
            'setupSurface.relayMoveAlways',
            'setupSurface.relayMoveConfirm',
        ]);
    });
    it('offers "connect too" only when asked to, naming the relay, with the move still last (primary)', async () => {
        const CONNECT_TOO = 'setupSurface.relayConnectToo:{"relay":"new.example.test"}';
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled(CONNECT_TOO);
        });
        await expect(presentRelayReconciliationConsent({ ...RELAY_MOVE, offerConnectToo: true })).resolves.toBe('connectToo');
        const relayButtons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2].map((button) => button.text);
        expect(relayButtons.at(-1)).toBe('setupSurface.relayMoveConfirm');

        alertAsyncSpy.mockClear();
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled(CONNECT_TOO);
        });
        await expect(presentRelayReconciliationConsent({ ...ACCOUNT_MOVE, fromRelayHost: 'self.example.test', offerConnectToo: true })).resolves.toBe('connectToo');
        const accountButtons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2].map((button) => button.text);
        expect(accountButtons.at(-1)).toBe('setupSurface.accountMoveConfirm');

        alertAsyncSpy.mockClear();
        await presentRelayReconciliationConsent(RELAY_MOVE);
        const plainButtons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2].map((button) => button.text);
        expect(plainButtons).not.toContain(CONNECT_TOO);
    });
});
