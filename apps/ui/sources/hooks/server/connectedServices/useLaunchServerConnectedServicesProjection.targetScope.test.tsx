import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import { AccountProfileSchema } from '@happier-dev/protocol';

import { flushHookEffects, renderHook } from '@/dev/testkit';

/**
 * HPI-19: the new-session picker joins the launch server's pools with that server's own profiles.
 * Home is A; the launch target is B. Server registry, auth storage and feature flags are fixtures;
 * the scope resolver, both HTTP reads (real fetch path, stubbed transport), schemas, option resolver
 * and Start-on list builder are the production ones.
 */
const env = vi.hoisted(() => ({
    activeCredentials: { token: 'home-a-token', secret: 's' } as { token: string; secret: string } | null,
    targetCredentials: { token: 'target-b-token', secret: 's' } as { token: string; secret: string } | null,
    homeProfile: null as unknown,
}));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ credentials: env.activeCredentials }) }));
vi.mock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentialsForServerUrl: async () => env.targetCredentials } }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/store/hooks', () => ({ useProfile: () => env.homeProfile }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'active-a', serverUrl: 'https://active-a.example.test', kind: 'custom', generation: 1 }),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
    resolveServerProfileScopeIdForIdentifier: (id: string) => id,
    getServerProfileById: (id: string) => (id === 'target-b' ? { id, serverUrl: 'https://target-b.example.test' }
        : id === 'active-a' ? { id, serverUrl: 'https://active-a.example.test' } : null),
}));
vi.mock('@/utils/timing/time', async (original) => ({
    ...await original<typeof import('@/utils/timing/time')>(),
    backoff: async <T,>(fn: () => Promise<T>) => await fn(),
}));

import { buildNewSessionConnectedServicesSelectionListModel } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import { resolveNewSessionConnectedServicesBindingsForAgent } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { useNewSessionPerSessionAccountGroups } from '@/components/sessions/new/modules/useNewSessionPerSessionAccountGroups';
import { useLaunchServerConnectedServicesProjection } from './useLaunchServerConnectedServicesProjection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const serviceId = 'claude-subscription';

function group(server: 'a' | 'b') {
    const groupId = `pool-${server}`;
    return {
        v: 1, serviceId, groupId, displayName: `Pool ${server}`, activeProfileId: `${server}-work`, generation: 1, runtimeStateRevision: 0,
        policy: { v: 1, strategy: 'per_session_softmax', autoSwitch: true }, state: { v: 1 },
        members: [{ v: 1, serviceId, groupId, profileId: `${server}-work`, enabled: true, priority: 1, state: { v: 1 }, createdAt: 1, updatedAt: 1 }],
        createdAt: 1, updatedAt: 1,
    };
}

function projection(server: 'a' | 'b') {
    return AccountProfileSchema.shape.connectedServicesV2.parse([{
        serviceId,
        profiles: [{ profileId: `${server}-work`, status: 'connected', kind: 'oauth' }],
        groups: [{ groupId: `pool-${server}`, activeProfileId: `${server}-work`, memberProfileIds: [`${server}-work`] }],
    }]);
}

type Pending = { resolve: () => void };
function network(options: Readonly<{ holdTarget?: Pending[] }> = {}) {
    const calls: Array<{ origin: string; path: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ origin: url.origin, path: url.pathname, authorization: new Headers(init?.headers).get('authorization') });
        const server = url.origin.includes('target-b') ? 'b' : 'a';
        const respond = () => url.pathname.startsWith('/v3/connect/')
            ? new Response(JSON.stringify({ groups: [group(server)] }), { status: 200 })
            : url.pathname === '/v1/account/profile'
                ? new Response(JSON.stringify({ ...(env.homeProfile as object), id: `acct-${server}`, connectedServicesV2: projection(server) }), { status: 200 })
                : new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (server === 'b' && options.holdTarget) {
            return await new Promise<Response>((resolve) => { options.holdTarget!.push({ resolve: () => resolve(respond()) }); });
        }
        return respond();
    }));
    return calls;
}

/** The production data path of useNewSessionConnectedServices for one launch target. */
function useLaunchOptions(targetServerId: string) {
    const launch = useLaunchServerConnectedServicesProjection({ targetServerId, enabled: true });
    const groups = useNewSessionPerSessionAccountGroups({
        targetServerId, accountGroupsFeatureEnabled: true, supportedConnectedServiceIds: [serviceId], serviceProjectionSignature: 'sig',
    });
    const resolution = resolveNewSessionConnectedServicesBindingsForAgent({
        agentId: 'claude', agentCore: AGENTS_CORE.claude, agentOptionState: {},
        accountProfileConnectedServicesV2: launch.connectedServicesV2 ?? [],
        settings: { connectedServicesDefaultProfileByServiceId: {}, connectedServicesProfileLabelByKey: {} },
        connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled: true, accountGroupsByServiceId: groups,
    });
    return { status: launch.status, resolution };
}

function startOnOptions(resolution: ReturnType<typeof useLaunchOptions>['resolution'], groupId: string) {
    const model = buildNewSessionConnectedServicesSelectionListModel({
        supportedServiceIds: [serviceId],
        profileOptionsByServiceId: resolution.connectedServiceProfileOptionsByServiceId,
        accountGroupOptionsByServiceId: resolution.connectedServiceAccountGroupOptionsByServiceId,
        bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId } },
        quotaBadgesByKey: {}, setBindingForService: () => {}, onOpenSettings: () => {}, translate: (key: string) => key,
        resolveServiceTitle: (id: string) => id, renderSelectionIcon: () => null, renderSettingsIcon: () => null,
        renderQuotaBadges: () => null, renderNeedsReauthPill: () => null,
    } as never);
    return model.rootStep.sections.flatMap((section: any) => section.options).map((option: any) => ({ id: option.id, disabled: option.disabled === true }));
}

const flush = async () => await flushHookEffects({ cycles: 5, turns: 5 });
const groupIds = (resolution: ReturnType<typeof useLaunchOptions>['resolution']) =>
    (resolution.connectedServiceAccountGroupOptionsByServiceId[serviceId] ?? []).map((option: any) => option.groupId);

beforeEach(() => {
    env.activeCredentials = { token: 'home-a-token', secret: 's' };
    env.targetCredentials = { token: 'target-b-token', secret: 's' };
    env.homeProfile = { connectedServicesV2: projection('a') };
});
afterEach(() => vi.unstubAllGlobals());

describe('launch-server connected-service projection (HPI-19)', () => {
    it('enables B\'s pool and its Start-on member from B\'s own profiles, read with B\'s credentials', async () => {
        const calls = network();
        const hook = await renderHook(() => useLaunchOptions('target-b'));
        await flush();
        const { status, resolution } = hook.getCurrent();
        expect(status).toBe('target_loaded');
        expect(calls.filter((call) => call.origin === 'https://active-a.example.test')).toEqual([]);
        expect(new Set(calls.map((call) => call.authorization))).toEqual(new Set(['Bearer target-b-token']));
        expect(groupIds(resolution)).toEqual(['pool-b']);
        const options = startOnOptions(resolution, 'pool-b');
        expect(options.find((option) => option.id === `connected-service:${serviceId}:group:pool-b`)?.disabled).toBe(false);
        expect(options).toContainEqual({ id: `connected-service:${serviceId}:group:pool-b:start:b-work`, disabled: false });
        // Home's direct profile is not offered for the B target.
        expect((resolution.connectedServiceProfileOptionsByServiceId[serviceId] ?? []).map((option: any) => option.profileId)).not.toContain('a-work');
    });

    it('keeps B\'s options when Home has no Claude service at all', async () => {
        env.homeProfile = { connectedServicesV2: [] };
        network();
        const hook = await renderHook(() => useLaunchOptions('target-b'));
        await flush();
        expect(groupIds(hook.getCurrent().resolution)).toEqual(['pool-b']);
    });

    it('offers nothing of Home\'s while B is loading after a mounted A→B change', async () => {
        const held: Pending[] = [];
        network({ holdTarget: held });
        const hook = await renderHook((props: { target: string }) => useLaunchOptions(props.target), { initialProps: { target: 'active-a' } });
        await flush();
        expect(groupIds(hook.getCurrent().resolution)).toEqual(['pool-a']);
        await hook.rerender({ target: 'target-b' });
        await flush();
        expect(hook.getCurrent().status).toBe('target_loading');
        expect(groupIds(hook.getCurrent().resolution)).toEqual([]);
        await act(async () => { held.forEach((pending) => pending.resolve()); await flush(); });
        expect(groupIds(hook.getCurrent().resolution)).toEqual(['pool-b']);
    });

    it('offers nothing of Home\'s and sends nothing when B\'s credentials are missing', async () => {
        env.targetCredentials = null;
        const calls = network();
        const hook = await renderHook(() => useLaunchOptions('target-b'));
        await flush();
        expect(calls).toEqual([]);
        expect(hook.getCurrent().status).toBe('target_error');
        expect(groupIds(hook.getCurrent().resolution)).toEqual([]);
        expect(hook.getCurrent().resolution.connectedServiceProfileOptionsByServiceId[serviceId] ?? []).toEqual([]);
    });

    it('control: launching on Home uses Home\'s synced profile and makes no profile request', async () => {
        const calls = network();
        const hook = await renderHook(() => useLaunchOptions('active-a'));
        await flush();
        expect(hook.getCurrent().status).toBe('home');
        expect(calls.some((call) => call.path === '/v1/account/profile')).toBe(false);
        expect(groupIds(hook.getCurrent().resolution)).toEqual(['pool-a']);
    });
});
