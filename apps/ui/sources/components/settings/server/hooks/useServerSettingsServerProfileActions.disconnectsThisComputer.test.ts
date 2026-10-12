import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { DesktopLocalInspection } from '@/setup/deriveDesktopLocalSetupSnapshot';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

const modalSpies = vi.hoisted(() => ({
    alert: vi.fn(),
    confirm: vi.fn(async (_title?: string, _body?: string) => true),
    prompt: vi.fn(),
    show: vi.fn(),
}));

installServerSettingsHooksCommonModuleMocks({
    modal: () => createModalModuleMock({ spies: modalSpies }).module,
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
        });
    },
});

const state = vi.hoisted(() => ({
    order: [] as string[],
    inspection: { status: 'pending' } as DesktopLocalInspection,
    disconnectFails: false,
    /** The relay's service here was set up outside Happier: the task refuses by name. */
    disconnectUserOwned: false,
    /** This computer's services could not be listed at all. */
    disconnectUnknown: false,
}));

vi.mock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => true }));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        removeCredentialsForServerUrl: vi.fn(async () => {
            state.order.push('removeCredentials');
        }),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    removeServerProfile: () => {
        state.order.push('removeProfile');
    },
    renameServerProfile: vi.fn(),
    resolveServerProfileScopeId: (profile: { id: string }) => profile.id,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'relay-a', serverUrl: 'https://relay-a.example.test', generation: 1 }),
}));

/** The system-task bridge boundary: what the desktop asks hsetup to run for this computer. */
vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => ({
        mode: 'dev',
        start: async (spec: { kind: string; params: { relayUrl?: string } }) => {
            state.order.push(`${spec.kind}:${spec.params.relayUrl ?? ''}`);
            return 'task_disconnect';
        },
        subscribe: (_taskId: string, _onEvent: unknown, onResult?: (result: unknown) => void) => {
            queueMicrotask(() => onResult?.(state.disconnectUnknown
                ? { protocolVersion: 1, taskId: 'task_disconnect', ok: false, error: { code: 'pinned_services_unknown', message: 'could not be listed' } }
                : state.disconnectUserOwned
                ? { protocolVersion: 1, taskId: 'task_disconnect', ok: false, error: { code: 'service_user_owned', message: 'set up outside Happier' } }
                : state.disconnectFails
                ? { protocolVersion: 1, taskId: 'task_disconnect', ok: false, error: { code: 'daemon_service_still_installed', message: 'still installed' } }
                : { protocolVersion: 1, taskId: 'task_disconnect', ok: true, data: { removed: true } }));
            return () => {};
        },
        getSnapshot: () => null,
        cancel: async () => {},
        respond: async () => {},
    }),
}));

vi.mock('@/setup/desktopSetupCoordinator', () => ({
    desktopSetupCoordinator: {
        readInspectionSnapshot: () => state.inspection,
        inspect: vi.fn(async () => state.inspection),
    },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RELAY_B = 'https://relay-b.example.test';
const PROFILE = { id: 'relay-b', name: 'Relay B', serverUrl: RELAY_B, createdAt: 0, updatedAt: 0, lastUsedAt: 0 };

function facts(serverUrl: string, targetMode: 'default-following' | 'pinned', managedBy?: 'desktop' | null) {
    return {
        acquisition: { command: '/managed/happier', provenance: 'managed' as const, version: null, channel: null },
        server: { serverUrl, publicServerUrl: serverUrl, localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid' as const, validatedAccountId: 'acct_b', accountId: 'acct_b', accountLabel: null, machineId: 'machine-b' },
        service: { installed: true, running: true, autostart: 'at-login' as const, targetMode, ...(managedBy !== undefined ? { managedBy } : {}) },
        runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    };
}

function inspectionWithRelayB(managedBy: 'desktop' | null): DesktopLocalInspection {
    return {
        status: 'resolved',
        facts: facts('https://relay-a.example.test', 'default-following'),
        pinnedServices: [facts(RELAY_B, 'pinned', managedBy)],
        pinnedServicesComplete: true,
        // The executor's list of this computer's services (R16): relay B has its own.
        serviceRows: [
            { relayUrl: 'https://relay-a.example.test', state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] },
            { relayUrl: RELAY_B, state: 'connected', appManaged: managedBy === 'desktop', serving: 'pinned', actions: [] },
        ],
    };
}

async function removeRelayB(): Promise<void> {
    const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
    let actions: ReturnType<typeof useServerSettingsServerProfileActions> | null = null;
    function Probe() {
        actions = useServerSettingsServerProfileActions({
            authStatusByServerId: {},
            onSelectServerById: vi.fn(async () => {}),
            onAfterSignedOutSwitch: vi.fn(),
            setRevision: vi.fn(),
        });
        return null;
    }
    await renderScreen(React.createElement(Probe));
    await actions!.onRemoveServer(PROFILE);
}

describe('removing a relay this computer is connected to (H3)', () => {
    beforeEach(() => {
        state.order = [];
        state.disconnectFails = false;
        state.disconnectUserOwned = false;
        state.disconnectUnknown = false;
        modalSpies.confirm.mockImplementation(async () => true);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('says this computer disconnects too, and removes its service before any credential or profile', async () => {
        state.inspection = inspectionWithRelayB('desktop');

        await removeRelayB();

        const body = String(modalSpies.confirm.mock.calls[0]?.[1] ?? '');
        expect(body).toContain('server.removeServerDisconnectsThisComputer');
        expect(state.order).toEqual([
            `daemon.service.relay.disconnect.v1:${RELAY_B}`,
            'removeCredentials',
            'removeProfile',
        ]);
    });

    it('stops, keeping the relay and its credentials, when the service could not be removed', async () => {
        state.inspection = inspectionWithRelayB('desktop');
        state.disconnectFails = true;

        await removeRelayB();

        expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`]);
        expect(modalSpies.alert).toHaveBeenCalled();
    });

    it('leaves a service the user set up in place and says so', async () => {
        state.inspection = inspectionWithRelayB(null);
        state.disconnectUserOwned = true;

        await removeRelayB();

        const body = String(modalSpies.confirm.mock.calls[0]?.[1] ?? '');
        expect(body).toContain('server.removeServerKeepsUserService');
        // The task decides from this computer's own inventory; a user-owned service is its answer, not a failure.
        expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`, 'removeCredentials', 'removeProfile']);
    });

    it('offers an explicit "Remove anyway" when this computer\'s services cannot be listed, instead of a dead end (R10-1)', async () => {
        state.inspection = { status: 'pending' };
        state.disconnectUnknown = true;
        modalSpies.confirm.mockImplementationOnce(async () => true).mockImplementationOnce(async () => true);

        await removeRelayB();

        expect(String(modalSpies.confirm.mock.calls[1]?.[1] ?? '')).toContain('server.removeServerAnywayBody');
        expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`, 'removeCredentials', 'removeProfile']);

        state.order = [];
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockImplementationOnce(async () => true).mockImplementationOnce(async () => false);
        await removeRelayB();
        expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`]);
    });

    it('keeps the relay when the app knows its own service serves it but could not remove it (R10-1)', async () => {
        state.inspection = inspectionWithRelayB('desktop');
        state.disconnectUnknown = true;

        await removeRelayB();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert).toHaveBeenCalled();
        expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`]);
    });

    it('still disconnects this computer first when the app could not see its services (N2)', async () => {
        for (const inspection of [
            { status: 'pending' } as DesktopLocalInspection,
            { ...inspectionWithRelayB('desktop'), pinnedServices: [], pinnedServicesComplete: false, serviceRows: [] } as DesktopLocalInspection,
        ]) {
            state.order = [];
            state.inspection = inspection;
            modalSpies.confirm.mockClear();

            await removeRelayB();

            expect(String(modalSpies.confirm.mock.calls[0]?.[1] ?? '')).toContain('server.removeServerMayDisconnectThisComputer');
            expect(state.order).toEqual([`daemon.service.relay.disconnect.v1:${RELAY_B}`, 'removeCredentials', 'removeProfile']);
        }
    });
});
