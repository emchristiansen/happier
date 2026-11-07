import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installActivityBadgeRuntimeCommonModuleMocks } from './activityBadgeRuntimeTestHelpers';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'web' | 'ios' | 'android',
}));

let isTauriDesktopValue = false;
let isDataReadyValue = true;
let sessionsValue: any[] = [];
let sessionListRenderablesValue: any[] = [];
let friendRequestsValue: Array<{ id: string }> = [];
let localSettingsValue: Record<string, unknown> = {
    activityBadgesEnabled: true,
    activityBadgeShowUnread: true,
    activityBadgeShowPendingPermissionRequests: true,
    activityBadgeShowPendingUserActionRequests: true,
    activityBadgeShowQueuedUserInput: true,
    activityBadgeShowFriendRequestsInboxCount: true,
    activityBadgeShowDesktopNonNumericDot: true,
};
let updateAvailableValue = false;
let changelogUnreadValue = false;
let rejectBroadLocalSettingsRead = false;

function indexFixturesById<T extends { id: string }>(items: readonly T[]): Record<string, T> {
    return Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;
}

const applyExpoNativeBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const applyTauriBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const serverFetch = vi.hoisted(() => vi.fn());
const activeServerSnapshot = vi.hoisted(() => ({
    value: {
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        generation: 1,
    },
}));

installActivityBadgeRuntimeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
            return createStorageModuleStub({
                getStorage: () => createStorageStoreMock({
                    sessions: indexFixturesById(sessionsValue),
                    sessionListRenderables: indexFixturesById(sessionListRenderablesValue),
                    isDataReady: isDataReadyValue,
                }),
                useAllSessions: () => sessionsValue,
                useAllSessionListRenderables: () => sessionListRenderablesValue,
                useAllSessionsForAttention: () => sessionsValue,
                useAllSessionListRenderablesForAttention: () => sessionListRenderablesValue,
                useIsDataReady: () => isDataReadyValue,
                useFriendRequestCount: () => friendRequestsValue.length,
                useLocalSettings: () => {
                    if (rejectBroadLocalSettingsRead) {
                        throw new Error('ActivityBadgeRuntime must use focused local setting hooks');
                    }
                    return localSettingsValue;
                },
                useLocalSetting: <K extends keyof LocalSettings>(key: K) => (
                    Object.prototype.hasOwnProperty.call(localSettingsValue, key)
                        ? localSettingsValue[key] as LocalSettings[K]
                        : localSettingsDefaults[key]
                ),
        });
    },
});

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({ updateAvailable: updateAvailableValue }),
}));

vi.mock('@/hooks/inbox/useChangelog', () => ({
    useChangelog: () => ({ hasUnread: changelogUnreadValue }),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopValue,
}));

vi.mock('./channels/applyExpoNativeBadgeState', () => ({
    applyExpoNativeBadgeState,
}));

vi.mock('./channels/applyTauriBadgeState', () => ({
    applyTauriBadgeState,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshot.value,
}));

describe('ActivityBadgeRuntime', () => {
    afterEach(() => {
        platformState.os = 'ios';
        isTauriDesktopValue = false;
        isDataReadyValue = true;
        sessionsValue = [];
        sessionListRenderablesValue = [];
        friendRequestsValue = [];
        localSettingsValue = {
            activityBadgesEnabled: true,
            activityBadgeShowUnread: true,
            activityBadgeShowPendingPermissionRequests: true,
            activityBadgeShowPendingUserActionRequests: true,
            activityBadgeShowQueuedUserInput: true,
            activityBadgeShowFriendRequestsInboxCount: true,
            activityBadgeShowDesktopNonNumericDot: true,
        };
        updateAvailableValue = false;
        changelogUnreadValue = false;
        rejectBroadLocalSettingsRead = false;
        applyExpoNativeBadgeState.mockClear();
        applyTauriBadgeState.mockClear();
        serverFetch.mockReset();
        activeServerSnapshot.value = {
            serverId: 'server-1',
            serverUrl: 'https://api.example.test',
            generation: 1,
        };
    });

    it('applies the native mobile badge count from session and inbox activity', async () => {
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                hasPendingPermissionRequests: true,
                pendingUserActionRequestCount: 0,
                hasUnreadMessages: true,
                pendingCount: 1,
                metadata: { path: '', host: '' },
            },
        ];
        friendRequestsValue = [{ id: 'friend-1' }, { id: 'friend-2' }];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 3,
            showNonNumericDot: false,
        });
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies badge counts from unread session-list renderables', async () => {
        sessionListRenderablesValue = [
            {
                id: 'session-renderable',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: false,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: null,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                hasUnreadMessages: true,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies the queued-input badge setting', async () => {
        sessionListRenderablesValue = [
            {
                id: 'session-queued',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: null,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                hasUnreadMessages: false,
                pendingCount: 1,
                pendingBlockedCount: 0,
            },
        ];
        localSettingsValue = {
            ...localSettingsValue,
            activityBadgeShowUnread: false,
            activityBadgeShowPendingPermissionRequests: false,
            activityBadgeShowPendingUserActionRequests: false,
            activityBadgeShowQueuedUserInput: true,
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');
        const screen = await renderScreen(<ActivityBadgeRuntime />);

        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        localSettingsValue.activityBadgeShowQueuedUserInput = false;
        await screen.update(<ActivityBadgeRuntime />);

        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await screen.unmount();
    });

    it('counts a canonical unread session when the renderable unread flag is stale', async () => {
        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                metadata: null,
            },
        ];
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 4,
                metadata: null,
                hasUnreadMessages: false,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not count stale renderable unread state when the canonical session is read', async () => {
        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 4,
                metadata: null,
            },
        ];
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                metadata: null,
                hasUnreadMessages: true,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies a lower tauri badge count when a session read cursor changes', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                metadata: null,
            },
            {
                id: 'session-2',
                seq: 3,
                latestReadyEventSeq: 3,
                lastViewedSessionSeq: 1,
                metadata: null,
            },
        ];
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 1,
                metadata: null,
                hasUnreadMessages: true,
            },
            {
                id: 'session-2',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: null,
                hasUnreadMessages: true,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyTauriBadgeState).toHaveBeenLastCalledWith({
            count: 2,
            showNonNumericDot: false,
        });

        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 4,
                metadata: null,
            },
            {
                id: 'session-2',
                seq: 3,
                latestReadyEventSeq: 3,
                lastViewedSessionSeq: 1,
                metadata: null,
            },
        ];
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 4,
                metadata: null,
                hasUnreadMessages: false,
            },
            {
                id: 'session-2',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: null,
                hasUnreadMessages: true,
            },
        ];

        await act(async () => {
            tree?.update(<ActivityBadgeRuntime />);
        });

        expect(applyTauriBadgeState).toHaveBeenLastCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not reapply native badge channels when session identity changes without badge state changes', async () => {
        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 10,
                metadata: null,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        sessionsValue = [
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 11,
                metadata: null,
            },
        ];

        await act(async () => {
            tree?.update(<ActivityBadgeRuntime />);
        });

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not clear native badges while session data is still bootstrapping', async () => {
        isDataReadyValue = false;

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies tauri badge counts from warm session rows before full data readiness', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        isDataReadyValue = false;
        sessionListRenderablesValue = [
            {
                id: 'session-warm-unread',
                seq: 4,
                updatedAt: 10,
                createdAt: 1,
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                metadata: null,
                metadataVersion: 0,
                agentStateVersion: 0,
                hasUnreadMessages: true,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });
        expect(serverFetch).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not use the server snapshot while queued-input badges are enabled', async () => {
        isDataReadyValue = false;
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(serverFetch).not.toHaveBeenCalled();
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('seeds the native badge from the server snapshot when its fixed policy matches local settings', async () => {
        isDataReadyValue = false;
        localSettingsValue = {
            ...localSettingsValue,
            activityBadgeShowQueuedUserInput: false,
        };
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(serverFetch).toHaveBeenCalledWith('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });
        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 4,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('preserves local-only friend request badge sources while session data is bootstrapping', async () => {
        isDataReadyValue = false;
        friendRequestsValue = [{ id: 'friend-1' }, { id: 'friend-2' }];
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 2,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('preserves local-only non-numeric inbox attention while session data is bootstrapping', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        isDataReadyValue = false;
        updateAvailableValue = true;
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: true,
        });
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('clears badge channels when badges are disabled on this device', async () => {
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
            },
        ];
        friendRequestsValue = [{ id: 'friend-1' }];
        localSettingsValue = {
            ...localSettingsValue,
            activityBadgesEnabled: false,
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows the tauri dock dot only for non-numeric inbox attention when enabled', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        updateAvailableValue = true;

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: true,
        });
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('reads activity badge preferences through focused local-setting hooks', async () => {
        rejectBroadLocalSettingsRead = true;
        sessionListRenderablesValue = [
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
                hasUnreadMessages: true,
            },
        ];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });
});
