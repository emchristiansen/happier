import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';


installServerSettingsHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => true),
                prompt: vi.fn(async () => null),
                show: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

const promptSignedOutServerSwitchConfirmationMock = vi.fn(async () => true);
vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: promptSignedOutServerSwitchConfirmationMock,
}));

/**
 * R8/INV7 — a group names several relays and cannot name the one relay a person chose for this
 * device, so switching a group must never arm the direct-relay intent that authorises repointing
 * this computer's background service.
 */
const recordDirectRelaySelectionIntentMock = vi.hoisted(() => vi.fn());
vi.mock('@/setup/directRelaySelectionIntent', () => ({
    recordDirectRelaySelectionIntent: recordDirectRelaySelectionIntentMock,
    consumeDirectRelaySelectionIntent: vi.fn(() => false),
}));

async function renderHook<T extends object>(
    useValue: () => T,
): Promise<T & { __cleanup: () => Promise<void> }> {
    let current: T | null = null;
    let tree: renderer.ReactTestRenderer | null = null;

    function Test() {
        current = useValue();
        return null;
    }

    tree = (await renderScreen(React.createElement(Test))).tree;

    if (!current) {
        throw new Error('Hook did not render');
    }

    return Object.assign(current, {
        __cleanup: async () => {
            if (!tree) {
                return;
            }
            await act(async () => {
                tree?.unmount();
            });
            tree = null;
        },
    });
}

function makeServerProfile(id: string, name: string, serverUrl: string): ServerProfile {
    return {
        id,
        name,
        serverUrl,
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    };
}

describe('useServerSettingsGroupActions', () => {
    const mountedHookCleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        mountedHookCleanups.length = 0;
        promptSignedOutServerSwitchConfirmationMock.mockReset();
        promptSignedOutServerSwitchConfirmationMock.mockResolvedValue(true);
        vi.clearAllMocks();
    });

    afterEach(async () => {
        while (mountedHookCleanups.length > 0) {
            const cleanup = mountedHookCleanups.pop();
            if (!cleanup) {
                continue;
            }
            await cleanup();
        }
        vi.resetModules();
    });

    it('seeds default selection when deleting the active server group', async () => {
        const { useServerSettingsGroupActions } = await import('./useServerSettingsGroupActions');
        const activeServerId = 'server-a';
        const setServerSelectionActiveTargetKind = vi.fn();
        const setServerSelectionActiveTargetId = vi.fn();
        const setServerSelectionGroups = vi.fn();
        const setRevision = vi.fn();
        const serverA = makeServerProfile('server-a', 'Server A', 'http://localhost:3013');
        const serverB = makeServerProfile('server-b', 'Server B', 'http://localhost:3012');

        const actions = await renderHook(() => useServerSettingsGroupActions({
            servers: [serverA, serverB],
            activeServerId,
            validServerIds: new Set(['server-a', 'server-b']),
            authStatusByServerId: { 'server-a': 'signedIn' },
            normalizedGroupProfiles: [
                { id: 'grp', name: 'Group', serverIds: ['server-a', 'server-b'], presentation: 'grouped' } as const,
            ],
            activeGroupId: 'grp',
            groupPresentation: 'grouped',
            setRevision: setRevision as unknown as React.Dispatch<React.SetStateAction<number>>,
            onSwitchServerById: vi.fn(async () => {}),
            onAfterSignedOutSwitch: vi.fn(),
            setServerSelectionActiveTargetKind,
            setServerSelectionActiveTargetId,
            setServerSelectionGroups,
        }));
        mountedHookCleanups.push(actions.__cleanup);

        await actions.onRemoveGroup({ id: 'grp', name: 'Group', serverIds: ['server-a', 'server-b'], presentation: 'grouped' });

        expect(setServerSelectionGroups).toHaveBeenCalledTimes(1);
        expect(setServerSelectionActiveTargetKind).toHaveBeenCalledWith('server');
        expect(setServerSelectionActiveTargetId).toHaveBeenCalledWith(activeServerId);
    });

    it('switching to a server selects an explicit server target and disables group mode', async () => {
        const { useServerSettingsGroupActions } = await import('./useServerSettingsGroupActions');
        const setServerSelectionActiveTargetKind = vi.fn();
        const setServerSelectionActiveTargetId = vi.fn();
        const setServerSelectionGroups = vi.fn();
        const onSwitchServerById = vi.fn(async () => {});
        const setRevision = vi.fn();
        const serverA = makeServerProfile('server-a', 'Server A', 'http://localhost:3013');
        const serverB = makeServerProfile('server-b', 'Server B', 'http://localhost:3012');

        const actions = await renderHook(() => useServerSettingsGroupActions({
            servers: [serverA, serverB],
            activeServerId: 'server-a',
            validServerIds: new Set(['server-a', 'server-b']),
            authStatusByServerId: { 'server-b': 'signedIn' },
            normalizedGroupProfiles: [
                { id: 'grp', name: 'Group', serverIds: ['server-a', 'server-b'], presentation: 'grouped' } as const,
            ],
            activeGroupId: 'grp',
            groupPresentation: 'grouped',
            setRevision: setRevision as unknown as React.Dispatch<React.SetStateAction<number>>,
            onSwitchServerById,
            onAfterSignedOutSwitch: vi.fn(),
            setServerSelectionActiveTargetKind,
            setServerSelectionActiveTargetId,
            setServerSelectionGroups,
        }));
        mountedHookCleanups.push(actions.__cleanup);

        await actions.onSwitchGroup({ id: 'grp', name: 'Group', serverIds: ['server-a', 'server-b'], presentation: 'grouped' });

        expect(setServerSelectionActiveTargetKind).toHaveBeenCalledWith('group');
        expect(setServerSelectionActiveTargetId).toHaveBeenCalledWith('grp');
        expect(onSwitchServerById).not.toHaveBeenCalled();
        expect(setRevision).toHaveBeenCalled();
    });

    it('creates a server group from the add-server-group flow', async () => {
        const { useServerSettingsGroupActions } = await import('./useServerSettingsGroupActions');
        const setServerSelectionActiveTargetKind = vi.fn();
        const setServerSelectionActiveTargetId = vi.fn();
        const setServerSelectionGroups = vi.fn();
        const onSwitchServerById = vi.fn(async () => {});
        const setRevision = vi.fn();
        const serverA = makeServerProfile('server-a', 'Server A', 'http://localhost:3013');
        const serverB = makeServerProfile('server-b', 'Server B', 'http://localhost:3012');

        const actions = await renderHook(() => useServerSettingsGroupActions({
            servers: [serverA, serverB],
            activeServerId: 'server-a',
            validServerIds: new Set(['server-a', 'server-b']),
            authStatusByServerId: { 'server-a': 'signedIn' },
            normalizedGroupProfiles: [],
            activeGroupId: null,
            groupPresentation: 'grouped',
            setRevision: setRevision as unknown as React.Dispatch<React.SetStateAction<number>>,
            onSwitchServerById,
            onAfterSignedOutSwitch: vi.fn(),
            setServerSelectionActiveTargetKind,
            setServerSelectionActiveTargetId,
            setServerSelectionGroups,
        }));
        mountedHookCleanups.push(actions.__cleanup);

        const created = await actions.onCreateServerGroup({
            name: 'My Group',
            serverIds: ['server-a', 'server-b'],
        });

        expect(created).toBe(true);
        expect(setServerSelectionGroups).toHaveBeenCalledTimes(1);
        expect(setServerSelectionActiveTargetKind).toHaveBeenCalledWith('group');
        expect(setServerSelectionActiveTargetId).toHaveBeenCalled();
        expect(setRevision).toHaveBeenCalled();
    });

    it('looks up same-URL target auth with serverId before switching a group', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (_serverUrl, options) => {
            if (options?.serverId === 'server-b') {
                return null;
            }
            return { token: 'token-a', secret: 'secret-a' };
        });

        const { useServerSettingsGroupActions } = await import('./useServerSettingsGroupActions');
        const setServerSelectionActiveTargetKind = vi.fn();
        const setServerSelectionActiveTargetId = vi.fn();
        const setServerSelectionGroups = vi.fn();
        const onSwitchServerById = vi.fn(async () => {});
        const onAfterSignedOutSwitch = vi.fn();
        const setRevision = vi.fn();
        const sharedUrl = 'https://shared.example.test';
        const serverA = makeServerProfile('server-a', 'Server A', sharedUrl);
        const serverB = makeServerProfile('server-b', 'Server B', sharedUrl);

        const actions = await renderHook(() => useServerSettingsGroupActions({
            servers: [serverA, serverB],
            activeServerId: 'server-a',
            validServerIds: new Set(['server-a', 'server-b']),
            authStatusByServerId: {},
            normalizedGroupProfiles: [
                { id: 'grp', name: 'Group', serverIds: ['server-b'], presentation: 'grouped' } as const,
            ],
            activeGroupId: null,
            groupPresentation: 'grouped',
            setRevision: setRevision as unknown as React.Dispatch<React.SetStateAction<number>>,
            onSwitchServerById,
            onAfterSignedOutSwitch,
            setServerSelectionActiveTargetKind,
            setServerSelectionActiveTargetId,
            setServerSelectionGroups,
        }));
        mountedHookCleanups.push(actions.__cleanup);

        await actions.onSwitchGroup({ id: 'grp', name: 'Group', serverIds: ['server-b'], presentation: 'grouped' });

        expect(TokenStorage.getCredentialsForServerUrl).toHaveBeenCalledWith(sharedUrl, { serverId: 'server-b' });
        expect(promptSignedOutServerSwitchConfirmationMock).toHaveBeenCalledTimes(1);
        expect(onSwitchServerById).toHaveBeenCalledWith('server-b');
        expect(onAfterSignedOutSwitch).toHaveBeenCalledTimes(1);
        // The group moved the active server, and still authorised no daemon reconciliation.
        expect(recordDirectRelaySelectionIntentMock).not.toHaveBeenCalled();
    });
});
