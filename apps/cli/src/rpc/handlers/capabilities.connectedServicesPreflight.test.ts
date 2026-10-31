import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import axios from 'axios';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupV1Schema,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { Credentials } from '@/persistence';

const envKeys = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS',
  'HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE',
  'HAPPIER_HOME_DIR',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'HAPPIER_FAKE_PROFILE_MARKER',
] as const;

let envScope = createEnvKeyScope(envKeys);
let tempDir: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/api/api');
  vi.doUnmock('@/persistence');
  vi.doUnmock('@/settings/accountSettings/bootstrapAccountSettingsContext');
  vi.resetModules();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('capabilities.invoke connected-service preflight', () => {
  it('probes native Codex auth without requiring a connected-service credential', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-native-preflight-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(
      new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url),
    );
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readCredentials: vi.fn(async () => null),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });
    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex', method: 'probeModels',
      params: {
        cwd: tempDir, timeoutMs: 5_000,
        connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'native' } } },
      },
    });
    expect(response).toMatchObject({ ok: true, result: { source: 'dynamic' } });
  }, 90_000);

  it('resolves the selected backend profile environment and encrypted Saved Secret before probing controls', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-profile-preflight-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(
      new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url),
    );
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
    const captureFile = join(tempDir, 'captured-profile-env.json');
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;
    const baseCodexHome = join(tempDir, 'base-codex-home');
    const profileCodexHome = join(tempDir, 'profile-codex-home');
    process.env.CODEX_HOME = baseCodexHome;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_SQLITE_HOME;
    delete process.env.HAPPIER_FAKE_PROFILE_MARKER;

    const recoverySecret = new Uint8Array(32).fill(7);
    const credentials: Credentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: recoverySecret },
    };
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const savedSecretKey = deriveSettingsSecretsKeyV1(machineKey);
    const encryptedValue = encryptSecretStringV1(
      'profile-api-key',
      savedSecretKey,
      (length) => new Uint8Array(length).fill(3),
    );

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readCredentials: vi.fn(async () => credentials),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        settings: {
          codexBackendMode: 'appServer',
          profiles: [{
            id: 'work',
            name: 'Work',
            environmentVariables: [
              { name: 'CODEX_HOME', value: profileCodexHome },
              { name: 'HAPPIER_FAKE_PROFILE_MARKER', value: 'selected-profile' },
              { name: 'OPENAI_API_KEY', value: '${PROFILE_OPENAI_API_KEY}' },
            ],
            envVarRequirements: [{ name: 'PROFILE_OPENAI_API_KEY', kind: 'secret', required: true }],
            compatibilityByTargetKey: { 'agent:codex': true },
            defaultEnabled: true,
            isBuiltIn: false,
          }],
          secrets: [{
            id: 'profile-openai-key',
            name: 'Profile OpenAI key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, encryptedValue },
          }],
          secretBindingsByProfileId: {
            work: { PROFILE_OPENAI_API_KEY: 'profile-openai-key' },
          },
        },
      })),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { cwd: tempDir, timeoutMs: 2_000, profileId: 'work' },
    });

    expect(response).toMatchObject({ ok: true, result: { source: 'dynamic' } });
    expect(JSON.parse(readFileSync(captureFile, 'utf8'))).toMatchObject({
      CODEX_HOME: profileCodexHome,
      HAPPIER_FAKE_PROFILE_MARKER: 'selected-profile',
      OPENAI_API_KEY: 'profile-api-key',
    });
  }, 90_000);

  it('materializes a selected Codex auth group through the canonical spawn resolver without a legacy stable home', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(
      new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url),
    );
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
    const captureFile = join(tempDir, 'captured-env.json');
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    // Keep real native-state sharing inside this fixture rather than the user's ambient home.
    process.env.CODEX_HOME = join(tempDir, 'native-codex-home');
    process.env.CODEX_SQLITE_HOME = process.env.CODEX_HOME;

    const credentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } satisfies Credentials;
    const credentialRecord = buildConnectedServiceCredentialRecord({
      now: 1_800_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: 1_900_000_000_000,
      oauth: {
        accessToken: 'selected-access-token',
        refreshToken: 'selected-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct_selected',
        providerEmail: null,
      },
    });
    const group = ConnectedServiceAuthGroupV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'happier',
      displayName: 'Selected accounts',
      activeProfileId: 'leeroy',
      generation: 1340,
      runtimeStateRevision: 1,
      policy: { autoSwitch: true, strategy: 'priority' },
      state: {}, createdAt: 1, updatedAt: 1,
      members: [{ v: 1, serviceId: 'openai-codex', groupId: 'happier',
        profileId: 'leeroy', enabled: true, priority: 0, state: {}, createdAt: 1, updatedAt: 1 }],
    });
    const requests: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-happier-token' });
      const data = path === '/v2/account/settings'
        ? { content: { t: 'plain', v: { schemaVersion: 6, codexBackendMode: 'appServer' } }, version: 1 }
        : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
        : path === '/v3/connect/openai-codex/groups/happier' ? { group }
        : path === '/v3/connect/openai-codex/profiles/leeroy/credential'
          ? { content: { t: 'plain', v: credentialRecord }, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }
        : path === '/v2/connect/openai-codex/profiles'
          ? { serviceId: 'openai-codex', profiles: [{ profileId: 'leeroy', status: 'connected' }] } : null;
      if (!data) throw new Error(`Unexpected selected-account HTTP request: ${path}`);
      return { status: 200, data };
    });
    const mutation = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Preflight must not mutate the selected group'));
    // Load the real API module before measuring the selected-account probe budget.
    await import('@/api/api');
    const { configuration, reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    await writeFile(configuration.privateKeyFile, JSON.stringify({ token: credentials.token,
      secret: Buffer.from(credentials.encryption.secret).toString('base64') }));
    const legacyGroupHome = join(
      configuration.activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      '__groups',
      'happier',
      'codex',
      'codex-home',
    );
    expect(existsSync(legacyGroupHome)).toBe(false);

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    // Resolve cold lazy catalog imports before measuring the selected-auth probe budget.
    await call(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        timeoutMs: 2_000,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { source: 'dynamic' } });
    expect(requests).toEqual(expect.arrayContaining([
      '/v3/connect/openai-codex/groups/happier',
      '/v3/connect/openai-codex/profiles/leeroy/credential',
    ]));
    expect(mutation).not.toHaveBeenCalled();
    const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
    expect(captured.CODEX_AUTH_FILE_PRESENT).toBe(true);
    const materializedBase = join(tempDir, 'daemon', 'connected-services', 'materialized');
    expect(relative(materializedBase, String(captured.CODEX_HOME))).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    // Connected auth stays isolated while the default state-sharing policy keeps
    // Codex's SQLite/session state rooted in the configured native home.
    expect(relative(materializedBase, String(captured.CODEX_SQLITE_HOME))).toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(String(captured.CODEX_HOME)).not.toBe(legacyGroupHome);
    expect(existsSync(String(captured.CODEX_HOME))).toBe(false);
  }, 90_000);

  it('fails closed instead of probing ambient auth when selected connected-service credentials are unavailable', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-no-credentials-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.OPENAI_API_KEY = 'ambient-key-must-not-be-used';

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readCredentials: vi.fn(async () => null),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'connected-service-preflight-failed',
        message: 'Could not prepare the selected connected-service account for this probe.',
      },
    });
  }, 90_000);
});
