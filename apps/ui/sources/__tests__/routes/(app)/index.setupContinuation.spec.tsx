import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

let isAuthenticated = true;
/** R11 — the moment right after signing in, which used to be held behind the setup ground. */
let authenticatedThisRun = false;
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
        authenticatedThisRun,
    }),
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => React.createElement('MainView'),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

const pendingTerminalConnectState = vi.hoisted(() => ({
    value: null as null | { publicKeyB64Url: string; serverUrl: string },
}));
vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectState.value,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));

type TestPendingSetupIntent = Readonly<{ branch: string; phase: string; relayUrl: string | null; machineId?: string | null }>;
const pendingSetupIntentState = vi.hoisted(() => ({
    value: {
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl: 'https://relay.example.test',
    } as TestPendingSetupIntent | null,
}));
const clearPendingSetupIntentSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => pendingSetupIntentState.value,
    clearPendingSetupIntent: () => clearPendingSetupIntentSpy(),
}));

describe('/ (welcome) setup continuation', () => {
    beforeEach(() => {
        isAuthenticated = true;
        authenticatedThisRun = false;
        tauriDesktopState.value = true;
        pendingTerminalConnectState.value = null;
        pendingSetupIntentState.value = {
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        };
        clearPendingSetupIntentSpy.mockReset();
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps a this-computer continuation at the root gate instead of routing to /setup, and consumes it (R9/INV1)', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).toHaveBeenCalledTimes(1);
    });

    it('still routes a remote-machine continuation to /setup, which owns provider follow-up', async () => {
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });

    it('does not redirect browser web users back to /setup when a setup auth continuation is pending', async () => {
        tauriDesktopState.value = false;
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });

    it('does not redirect to /setup while a terminal connect approval is pending', async () => {
        pendingTerminalConnectState.value = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://relay.example.test',
        };
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });

    it('opens the app straight after signing in on desktop, while this computer is still unresolved (R11)', async () => {
        // Nothing about this computer is known yet and the user has only just signed in — the
        // exact moment the first-run ground used to own the whole route. The Home renders now.
        authenticatedThisRun = true;
        pendingSetupIntentState.value = null;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType('MainView' as never)).toHaveLength(1);
    });
});
