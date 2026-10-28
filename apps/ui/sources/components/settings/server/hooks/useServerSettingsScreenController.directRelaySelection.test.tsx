import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

/**
 * R8/INV7 — which Settings › Server actions tell the desktop setup gate that a person chose a
 * relay for this computer.
 *
 * The gate may move this computer's background service to a new relay only when the direct-
 * selection intent names it (`useDesktopLocalSetupGate`); it refuses silently otherwise. So every
 * relay a person picks or adds here must arm that intent, including across the sign-in detour a
 * signed-out relay takes, and a deep-link auto-add — which nobody pressed — must arm nothing. The
 * intent module is real: what the gate would consume is exactly what these assertions read.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));
const routerReplaceMock = vi.fn();
const setActiveServerIdMock = vi.fn();
const switchConnectionToActiveServerMock = vi.fn(async () => {});
const refreshFromActiveServerMock = vi.fn(async () => {});
const promptSignedOutServerSwitchConfirmationMock = vi.hoisted(() => vi.fn(async () => true));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));

const ADDED_PROFILE = {
    id: 'server-added',
    serverUrl: 'https://added.example.test',
    name: 'Added',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
};

const storageState: Record<string, unknown> = {
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null,
    serverSelectionActiveTargetId: null,
};
const useSettingMutableMock = ((key: string) => [
    storageState[key],
    (value: unknown) => {
        storageState[key] = value;
    },
]) as typeof import('@/sync/domains/state/storage')['useSettingMutable'];

installServerSettingsHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { replace: routerReplaceMock },
            params: () => routeParams.current,
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: useSettingMutableMock,
        });
    },
});

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerMock }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
        removeCredentialsForServerUrl: vi.fn(async () => {}),
    },
}));

vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: promptSignedOutServerSwitchConfirmationMock,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    retargetPendingTerminalConnectToServerUrl: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 }) as any,
            subscribeActiveServer: () => () => {},
            listServerProfiles: () => [],
            getActiveServerId: () => 'server-a',
            getDeviceDefaultServerId: () => 'server-a',
            getResetToDefaultServerId: () => 'server-a',
            getTabActiveServerId: () => null,
            setActiveServerId: (...args: unknown[]) => setActiveServerIdMock(...args),
            upsertServerProfile: vi.fn(() => ADDED_PROFILE),
            removeServerProfile: vi.fn(),
        },
    });
});

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

vi.mock('@/sync/domains/server/url/serverUrlClassification', () => ({
    isInsecureRemoteHttpServerUrl: () => false,
    canSafelyAutoAdoptCanonicalServerUrl: () => false,
}));

vi.mock('@/sync/domains/server/selection/serverSelectionMutations', () => ({
    normalizeStoredServerSelectionGroups: (raw: unknown) => (Array.isArray(raw) ? raw : []),
    filterServerSelectionGroupsToAvailableServers: (profiles: any) => profiles,
}));

vi.mock('@/components/settings/server/hooks/useServerAuthStatusByServerId', () => ({
    useServerAuthStatusByServerId: () => ({}),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsConcurrentActions', () => ({
    useServerSettingsConcurrentActions: () => ({
        onTogglePresentation: vi.fn(),
        onToggleConcurrentServer: vi.fn(),
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'error', reason: 'network' })),
}));

async function renderController() {
    const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');
    const ref: { current: ReturnType<typeof useServerSettingsScreenController> | null } = { current: null };
    function Probe() {
        ref.current = useServerSettingsScreenController();
        return null;
    }
    await renderScreen(React.createElement(Probe));
    return ref;
}

async function addRelayFromForm(ref: Awaited<ReturnType<typeof renderController>>) {
    await act(async () => {
        ref.current?.onChangeUrl(ADDED_PROFILE.serverUrl);
    });
    await act(async () => {
        await ref.current?.onAddServer();
    });
}

describe('useServerSettingsScreenController (direct relay selection, R8/INV7)', () => {
    afterEach(() => {
        routeParams.current = {};
        runtimeFetchMock.mockClear();
        routerReplaceMock.mockClear();
        setActiveServerIdMock.mockClear();
        switchConnectionToActiveServerMock.mockClear();
        refreshFromActiveServerMock.mockClear();
        promptSignedOutServerSwitchConfirmationMock.mockReset();
        promptSignedOutServerSwitchConfirmationMock.mockResolvedValue(true);
        storageState.serverSelectionGroups = [];
        storageState.serverSelectionActiveTargetKind = null;
        storageState.serverSelectionActiveTargetId = null;
        vi.resetModules();
    });

    it('arms the intent for a relay the user adds, so signing in there offers to move this computer', async () => {
        const ref = await renderController();

        await addRelayFromForm(ref);

        // The signed-out relay takes the sign-in detour; the in-memory intent survives it for the
        // gate that mounts once authentication completes.
        expect(setActiveServerIdMock).toHaveBeenCalledWith('server-added', { scope: 'device' });
        expect(storageState.serverSelectionActiveTargetId).toBe('server-added');
        expect(routerReplaceMock).toHaveBeenLastCalledWith('/');
        const intent = await import('@/setup/directRelaySelectionIntent');
        expect(intent.consumeDirectRelaySelectionIntent('server-added')).toBe(true);
    });

    it('arms it for a notification-prefilled add too: the person still pressed Add', async () => {
        routeParams.current = { url: ADDED_PROFILE.serverUrl, source: 'notification' };
        const ref = await renderController();

        await addRelayFromForm(ref);

        const intent = await import('@/setup/directRelaySelectionIntent');
        expect(intent.consumeDirectRelaySelectionIntent('server-added')).toBe(true);
    });

    it('arms nothing for a deep-link auto-add nobody pressed', async () => {
        routeParams.current = { url: ADDED_PROFILE.serverUrl, auto: '1' };
        await renderController();
        await vi.waitFor(() => {
            expect(setActiveServerIdMock).toHaveBeenCalledWith('server-added', { scope: 'device' });
        });

        const intent = await import('@/setup/directRelaySelectionIntent');
        expect(intent.consumeDirectRelaySelectionIntent('server-added')).toBe(false);
    });

    it('arms it for a profile picked from the list, by its canonical scope id', async () => {
        const ref = await renderController();

        await act(async () => {
            await ref.current?.onSwitchServer({ ...ADDED_PROFILE, serverIdentityId: 'srv_identity_added' } as any);
        });

        const intent = await import('@/setup/directRelaySelectionIntent');
        expect(intent.consumeDirectRelaySelectionIntent('srv_identity_added')).toBe(true);
    });

    it('arms nothing when the user backs out of a signed-out switch', async () => {
        promptSignedOutServerSwitchConfirmationMock.mockResolvedValue(false);
        const ref = await renderController();

        await act(async () => {
            await ref.current?.onSwitchServer(ADDED_PROFILE as any);
        });

        expect(setActiveServerIdMock).not.toHaveBeenCalled();
        const intent = await import('@/setup/directRelaySelectionIntent');
        expect(intent.consumeDirectRelaySelectionIntent('server-added')).toBe(false);
    });
});
