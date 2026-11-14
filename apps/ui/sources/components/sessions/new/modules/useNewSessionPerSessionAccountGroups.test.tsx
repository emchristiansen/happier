import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * HPI-18: the new-session picker reads the per-session pools of the LAUNCH server. Home stays on A;
 * the launch target is B (and changes while mounted).
 */
const activeCredentials = { token: 'home-a-token', secret: 's' };
const targetCredentials = { token: 'target-b-token', secret: 's' };

const { listSpy, credentialsForServerUrlSpy } = vi.hoisted(() => ({
    listSpy: vi.fn(async (_credentials: unknown, params: { serviceId: string; serverUrl?: string | null }) => [{
        groupId: params.serverUrl ? 'pool-on-b' : 'pool-on-a',
        policy: { strategy: params.serverUrl ? 'per_session_softmax' : 'priority' },
        members: [],
    }]),
    credentialsForServerUrlSpy: vi.fn(async (_url: string, _options: unknown) => ({ token: 'target-b-token', secret: 's' })),
}));

vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ credentials: activeCredentials }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => ({ listConnectedServiceAuthGroupsV3: listSpy }));
vi.mock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentialsForServerUrl: credentialsForServerUrlSpy } }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://home-a.example.test', generation: 1 }),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
    resolveServerProfileScopeIdForIdentifier: (id: string) => id,
    getServerProfileById: (id: string) => id === 'server-b'
        ? { id: 'server-b', serverUrl: 'https://target-b.example.test', name: 'B' }
        : id === 'server-a' ? { id: 'server-a', serverUrl: 'https://home-a.example.test', name: 'A' } : null,
}));

import { useNewSessionPerSessionAccountGroups } from './useNewSessionPerSessionAccountGroups';

afterEach(() => {
    listSpy.mockClear();
    credentialsForServerUrlSpy.mockClear();
});

function render(targetServerId: string) {
    return renderHook((props: { targetServerId: string }) => useNewSessionPerSessionAccountGroups({
        targetServerId: props.targetServerId,
        accountGroupsFeatureEnabled: true,
        supportedConnectedServiceIds: ['claude-subscription'],
        serviceProjectionSignature: 'sig',
    }), { initialProps: { targetServerId } });
}

describe('useNewSessionPerSessionAccountGroups', () => {
    it('reads the launch server\'s pools with that server\'s credentials while Home stays elsewhere', async () => {
        const hook = await render('server-b');
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(credentialsForServerUrlSpy).toHaveBeenCalledWith('https://target-b.example.test', { serverId: 'server-b' });
        expect(listSpy).toHaveBeenCalledWith(targetCredentials, { serviceId: 'claude-subscription', serverUrl: 'https://target-b.example.test' });
        expect(hook.getCurrent()?.['claude-subscription']?.map((group) => group.groupId)).toEqual(['pool-on-b']);
    });

    it('keeps reading the active server when the launch target is Home', async () => {
        const hook = await render('server-a');
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(credentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(listSpy).toHaveBeenCalledWith(activeCredentials, { serviceId: 'claude-subscription' });
        expect(hook.getCurrent()?.['claude-subscription']?.map((group) => group.groupId)).toEqual(['pool-on-a']);
    });

    it('re-reads and never shows the previous server\'s pools after the launch target changes while mounted', async () => {
        const hook = await render('server-a');
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(hook.getCurrent()?.['claude-subscription']?.map((group) => group.groupId)).toEqual(['pool-on-a']);
        await hook.rerender({ targetServerId: 'server-b' });
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(listSpy).toHaveBeenLastCalledWith(targetCredentials, { serviceId: 'claude-subscription', serverUrl: 'https://target-b.example.test' });
        expect(hook.getCurrent()?.['claude-subscription']?.map((group) => group.groupId)).toEqual(['pool-on-b']);
    });
});
