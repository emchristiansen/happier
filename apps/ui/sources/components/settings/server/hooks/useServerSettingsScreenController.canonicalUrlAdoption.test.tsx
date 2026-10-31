import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();

const refreshFromActiveServerMock = vi.fn(async () => {});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerMock }),
}));

const modalConfirmMock = vi.fn(async (..._args: unknown[]) => true);

installServerSettingsHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { replace: replaceMock },
            params: {},
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: (...args: unknown[]) => modalConfirmMock(...args),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: () => [[], vi.fn()],
        });
    },
});

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

function createServerProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
    return {
        id: 'p0',
        serverUrl: 'http://example.test',
        name: 'Example',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        ...overrides,
    };
}

const upsertServerProfileMock = vi.fn((..._args: unknown[]): ServerProfile => createServerProfile({
    id: 'p0',
    serverUrl: 'http://example.test',
    name: 'Example',
}));
const removeServerProfileMock = vi.fn((..._args: unknown[]) => undefined);
const setActiveServerIdMock = vi.fn((..._args: unknown[]) => undefined);
const getServerProfileByIdMock = vi.fn((..._args: unknown[]): ServerProfile | null => null);
const activeServerSnapshot = { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 };
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    const mock = await createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            getActiveServerSnapshot: () => activeServerSnapshot as any,
            subscribeActiveServer: () => () => {},
            listServerProfiles: () => [],
            getActiveServerId: () => '',
            getDeviceDefaultServerId: () => '',
            getResetToDefaultServerId: () => '',
            getTabActiveServerId: () => null,
            setActiveServerId: (...args: unknown[]) => setActiveServerIdMock(...args),
            upsertServerProfile: ((...args: unknown[]) => upsertServerProfileMock(...args)) as any,
            removeServerProfile: (...args: unknown[]) => removeServerProfileMock(...args),
        },
    });
    // The testkit derives lookup from `listServerProfiles`; this suite drives lookup directly.
    return {
        ...mock,
        getServerProfileById: ((...args: unknown[]) => getServerProfileByIdMock(...args)) as any,
    };
});

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionMutations', () => ({
    normalizeStoredServerSelectionGroups: (raw: unknown) => (Array.isArray(raw) ? raw : []),
    filterServerSelectionGroupsToAvailableServers: (profiles: any) => profiles,
}));

vi.mock('@/components/settings/server/hooks/useServerAuthStatusByServerId', () => ({
    useServerAuthStatusByServerId: () => ({}),
}));

vi.mock('@/components/settings/server/hooks/useServerAutoAddFromRoute', () => ({
    useServerAutoAddFromRoute: () => {},
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsServerProfileActions', () => ({
    useServerSettingsServerProfileActions: () => ({
        onSwitchServer: vi.fn(async () => {}),
        onRenameServer: vi.fn(async () => {}),
        onRemoveServer: vi.fn(async () => {}),
    }),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsGroupActions', () => ({
    useServerSettingsGroupActions: () => ({
        onSwitchGroup: vi.fn(async () => {}),
        onRenameGroup: vi.fn(async () => {}),
        onRemoveGroup: vi.fn(async () => {}),
        onCreateServerGroup: vi.fn(async () => false),
    }),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsConcurrentActions', () => ({
    useServerSettingsConcurrentActions: () => ({
        onTogglePresentation: vi.fn(),
        onToggleConcurrentServer: vi.fn(),
    }),
}));

const runtimeFetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

const getServerFeaturesSnapshotMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    status: 'ready',
    features: {
        features: {},
        capabilities: {
            server: {
                canonicalServerUrl: 'https://canonical.example.test',
            },
        },
    },
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: unknown[]) => getServerFeaturesSnapshotMock(...args),
}));

describe('useServerSettingsScreenController (canonical URL adoption)', () => {
    beforeEach(() => {
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(true);
        upsertServerProfileMock.mockReset();
        removeServerProfileMock.mockReset();
        setActiveServerIdMock.mockReset();
        getServerProfileByIdMock.mockReset();
        getServerFeaturesSnapshotMock.mockReset();
    });

    it('offers to adopt canonicalServerUrl from /v1/features and migrates the stored profile', async () => {
        upsertServerProfileMock
            .mockReturnValueOnce({ id: 'p1', serverUrl: 'http://127.0.0.1:3005', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 })
            .mockReturnValueOnce({ id: 'p2', serverUrl: 'https://canonical.example.test', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {},
                capabilities: {
                    server: {
                        canonicalServerUrl: 'https://canonical.example.test',
                    },
                },
            },
        });

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            value.onChangeUrl('http://127.0.0.1:3005');
            value.onChangeName('Local');
        });

        await act(async () => {
            await value.onAddServer();
        });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'p1' }));
        expect(modalConfirmMock).toHaveBeenCalled();
        expect(upsertServerProfileMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ serverUrl: 'https://canonical.example.test' }),
        );
        expect(removeServerProfileMock).toHaveBeenCalledWith('p1');
        expect(setActiveServerIdMock).toHaveBeenCalledWith('p2', expect.anything());
    });

    it('switches to the server identity learned while validating a manually added server', async () => {
        upsertServerProfileMock.mockReturnValueOnce({
            id: 'p1',
            serverIdentityId: null,
            serverUrl: 'http://127.0.0.1:3005',
            name: 'Local',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {},
                capabilities: {
                    server: {},
                    serverIdentity: {
                        serverIdentityId: 'srv_identity_manual',
                    },
                },
            },
        });
        getServerProfileByIdMock.mockReturnValueOnce({
            id: 'p1',
            serverIdentityId: 'srv_identity_manual',
            serverUrl: 'http://127.0.0.1:3005',
            name: 'Local',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        });

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            value.onChangeUrl('http://127.0.0.1:3005');
            value.onChangeName('Local');
        });

        await act(async () => {
            await value.onAddServer();
        });

        expect(setActiveServerIdMock).toHaveBeenCalledWith('srv_identity_manual', expect.anything());
    });
});
