import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openConnectedServiceCredentialCiphertext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiClient } from '@/api/api';
import type { ConnectedServiceCredentialStorageApi } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';
import { registerMachineConnectedServiceImportRpcHandlers } from './rpcHandlers.connectedServiceImport';

const secret = new Uint8Array(32).fill(9);
const credentials = { token: 'synthetic', encryption: { type: 'legacy' as const, secret } };
const revision = 'csr_abcdefghijklmnopqrstuv';
const roots: string[] = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {}, capabilities: { connectedServices: { credentialWrite: { revisionGuard: true } } } }))); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function makeApi(overrides: Partial<ConnectedServiceCredentialStorageApi> = {}): ConnectedServiceCredentialStorageApi {
  return {
    getAccountEncryptionMode: async () => 'e2ee',
    getConnectedServiceCredentialPlain: async () => null,
    getConnectedServiceCredentialSealed: async () => null,
    registerConnectedServiceCredentialPlain: async () => ({ success: true, credentialRevision: revision }),
    registerConnectedServiceCredentialSealed: async () => ({ success: true, credentialRevision: revision }),
    ...overrides,
  };
}
function manager(api = makeApi()) {
  const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'synthetic-machine', encryptionKey: secret, encryptionVariant: 'legacy' });
  registerMachineConnectedServiceImportRpcHandlers({ rpcHandlerManager, account: { api, credentials } });
  return rpcHandlerManager;
}
function jwt(claims: Record<string, unknown>) { return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`; }
describe('native connected-service import machine RPC', () => {
  it.each([undefined, false, 'true'])('refuses import before native reads when credential write revision admission is %s', async (revisionGuard) => {
    vi.stubEnv('CODEX_HOME', '/synthetic/absent/native-home');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {}, capabilities: { connectedServices: { credentialWrite: { revisionGuard } } } })));
    expect(await manager().invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'import', serviceId: 'openai-codex', profileId: 'new', source: 'native' })).toMatchObject({ ok: false, errorCode: 'connected_service_unsupported' });
  });
  it('exposes the authenticated import operation through the actual API machine factory', async () => {
    const api = await ApiClient.create(credentials);
    const client = api.machineSyncClient({ id: 'synthetic-machine', encryptionKey: secret, encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    client.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'synthetic' }), stopSession: async () => true, requestShutdown: () => {} });
    const rpc = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'discover', serviceId: 'openai-codex' })).toMatchObject({ ok: true, op: 'discover' });
    await client.shutdown();
  });
  it('discovers only explicit OAuth service source declarations', async () => {
    expect(await manager().invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'discover', serviceId: 'openai-codex' })).toMatchObject({ ok: true, op: 'discover', sources: [{ id: 'native' }] });
    expect(await manager().invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'discover', serviceId: 'openai' })).toMatchObject({ ok: false, errorCode: 'unsupported' });
  });
  it('imports a synthetic native Codex login through encryption and revision storage without returning credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-import-')); roots.push(root); vi.stubEnv('CODEX_HOME', root);
    const claims = { exp: Math.floor(Date.now() / 1000) + 3600, email: 'synthetic@example.test' };
    await writeFile(join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt(claims), access_token: jwt(claims), refresh_token: 'synthetic-refresh', account_id: 'synthetic-account' } }));
    let stored: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0] | undefined;
    const api = makeApi({ registerConnectedServiceCredentialSealed: async (value) => { stored = value; return { success: true, credentialRevision: revision }; } });
    const result = await manager(api).invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'import', serviceId: 'openai-codex', profileId: 'named-profile', source: 'native' });
    expect(result).toEqual({ ok: true, op: 'import', serviceId: 'openai-codex', profileId: 'named-profile' });
    expect(stored?.expectedCredentialRevision).toBeNull();
    expect(openConnectedServiceCredentialCiphertext({ material: { type: 'legacy', secret }, ciphertext: stored!.sealed.ciphertext })).toMatchObject({ value: { serviceId: 'openai-codex', profileId: 'named-profile', oauth: { refreshToken: 'synthetic-refresh', providerAccountId: 'synthetic-account' } } });
  });
  it('rejects undeclared sources and cancellation before accessing native credentials', async () => {
    expect(await manager().invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'import', serviceId: 'openai-codex', profileId: 'new', source: '/private/arbitrary/path' })).toMatchObject({ ok: false, errorCode: 'unsupported_source' });
    const controller = new AbortController(); controller.abort();
    expect(await manager().invokeLocal(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, { op: 'import', serviceId: 'openai-codex', profileId: 'new', source: 'native' }, { signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
});
