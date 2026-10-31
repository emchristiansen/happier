import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

describe('Connected Service authoring admission', () => {
  it.each(['openai-codex', 'antigravity'] as const)('keeps admitted %s OAuth authoring usable', async (serviceId) => {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: () => ({ serverId: 'test', serverUrl: 'https://api.example.test', generation: 1 }) }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => null } }));
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const payload = path === '/v1/features'
        ? createRootLayoutFeaturesResponse({ capabilities: { connectedServices: { ...createRootLayoutFeaturesResponse().capabilities.connectedServices, supportedServiceIds: [...ConnectedServiceIdSchema.options] } } })
        : { bundle: 'oauth-bundle' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const { exchangeConnectedServiceOauthViaProxy } = await import('./apiConnectedServicesV2');
    await expect(exchangeConnectedServiceOauthViaProxy({ token: 't', secret: 's' }, { serviceId, publicKey: 'pk', code: 'code', verifier: 'verifier', redirectUri: 'https://callback.example.test' })).resolves.toEqual({ bundle: 'oauth-bundle' });
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === `/v2/connect/${serviceId}/oauth/exchange`)).toBe(true);
    if (serviceId === 'openai-codex') expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/v1/features')).toBe(false);
  });
  it.each(['exchange', 'sealed', 'plain'] as const)('refuses unsupported new-service %s before sending authoring requests', async (operation) => {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: () => ({ serverId: 'test', serverUrl: 'https://api.example.test', generation: 1 }) }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => null } }));
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const payload = path === '/v1/features' ? createRootLayoutFeaturesResponse()
        : path.endsWith('/oauth/exchange') ? { bundle: 'unused' }
        : { success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const v2 = await import('./apiConnectedServicesV2');
    const v3 = await import('./apiConnectedServicesV3');
    const credentials = { token: 't', secret: 's' };
    const serviceId = 'antigravity';
    const action = operation === 'exchange'
      ? () => v2.exchangeConnectedServiceOauthViaProxy(credentials, { serviceId, publicKey: 'pk', code: 'code', verifier: 'verifier', redirectUri: 'https://antigravity.google/oauth-callback' })
      : operation === 'sealed'
        ? () => v2.registerConnectedServiceCredentialSealed(credentials, { serviceId, profileId: 'work', sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' }, expectedCredentialRevision: null })
        : () => v3.registerConnectedServiceCredentialPlain(credentials, { serviceId, profileId: 'work', record: buildConnectedServiceCredentialRecord({ now: 1, serviceId, profileId: 'work', kind: 'token', token: { token: 'token', providerAccountId: null, providerEmail: null } }), revisionSemantics: 'revisioned', expectedCredentialRevision: null });
    await expect(action()).rejects.toMatchObject({ code: 'connect_service_unsupported' });
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname.includes('/connect/'))).toBe(false);
  });
});
