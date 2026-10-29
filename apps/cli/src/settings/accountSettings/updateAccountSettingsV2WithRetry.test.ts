import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import {
  AccountSettingsPersistedObjectSchema,
  accountSettingsParse,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import { updateAccountSettingsV2WithRetry } from './updateAccountSettingsV2WithRetry';
import type { AccountSettingsCache } from './accountSettingsCache';

type LegacyCredentialsStub = Credentials & Readonly<{ encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }> }>;

function createLegacyCredentialsStub(): LegacyCredentialsStub {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function mutableConfigurationForTest(): {
  serverUrl: string;
  apiServerUrl: string;
  publicServerUrl: string;
  webappUrl: string;
  clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
} {
  return configuration as unknown as {
    serverUrl: string;
    apiServerUrl: string;
    publicServerUrl: string;
    webappUrl: string;
    clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
  };
}

describe('updateAccountSettingsV2WithRetry', () => {
  const originalServerUrl = configuration.serverUrl;
  const originalApiServerUrl = configuration.apiServerUrl;
  const originalPublicServerUrl = configuration.publicServerUrl;
  const originalWebappUrl = configuration.webappUrl;
  const originalClientEncryptionRequirement = configuration.clientEncryptionRequirement;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: originalServerUrl,
      apiServerUrl: originalApiServerUrl,
      publicServerUrl: originalPublicServerUrl,
      webappUrl: originalWebappUrl,
      clientEncryptionRequirement: originalClientEncryptionRequirement,
    });
  });

  it('updates plain v2 content and posts plain content back', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials: { token: 'plain-token', encryption: null },
      mutate: (settings: Readonly<Record<string, unknown>>) => ({
        ...settings,
        mcpServersSettingsV1: { v: 1, strictMode: false, servers: [], bindings: [] },
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 6 };
        },
      },
    });

    expect(result.version).toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(5);
    expect(calls[0]?.content?.t).toBe('plain');
    expect((calls[0]?.content as any)?.v?.mcpServersSettingsV1).toEqual({ v: 1, strictMode: false, servers: [], bindings: [] });
  });

  it.each([
    { name: 'token-only', credentials: { token: 'plain-token', encryption: null } satisfies Credentials },
    { name: 'retained-key', credentials: createLegacyCredentialsStub() },
  ])('initializes empty plaintext settings from account authority for $name credentials', async ({ credentials }) => {
    Object.assign(mutableConfigurationForTest(), {
      apiServerUrl: 'https://settings.example.test', clientEncryptionRequirement: 'follow_account',
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url === 'https://settings.example.test/v2/account/settings') {
        return { status: 200, data: { content: null, version: 0 } };
      }
      if (url === 'https://settings.example.test/v1/account/encryption') {
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      }
      throw new Error(`Unexpected test HTTP GET: ${url}`);
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, version: 1 } });
    await expect(updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings) => ({ ...settings, example: 'nonempty' }),
      deps: { writeCache: async () => {} },
    })).resolves.toEqual({ version: 1 });
    expect(post).toHaveBeenCalledWith(
      'https://settings.example.test/v2/account/settings',
      { expectedVersion: 0, content: { t: 'plain', v: { example: 'nonempty' } } },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${credentials.token}` }) }),
    );
  });

  it.each([
    { mode: 'e2ee', requirement: 'follow_account', error: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' },
    { mode: 'plain', requirement: 'require_e2ee', error: 'CLIENT_E2EE_REQUIRED' },
    { mode: 'unknown', requirement: 'follow_account', error: null },
  ] as const)('refuses an initial write for $mode authority and $requirement policy', async ({ mode, requirement, error }) => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: requirement });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode, updatedAt: 1 } });
    const updateSettings = vi.fn();
    const result = updateAccountSettingsV2WithRetry({
      credentials: { token: 'keyless-token', encryption: null },
      mutate: (settings) => ({ ...settings, example: 'nonempty' }),
      deps: { fetchSettings: async () => ({ content: null, version: 0 }), updateSettings },
    });
    if (error) await expect(result).rejects.toMatchObject({ code: error });
    else await expect(result).rejects.toThrow('Cannot determine account encryption mode');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('reapplies a mutation to conflict content instead of the empty initial document', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const updates: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    await expect(updateAccountSettingsV2WithRetry({
      credentials: { token: 'keyless-token', encryption: null },
      mutate: (settings) => ({ ...settings, example: 'nonempty' }),
      deps: {
        fetchSettings: async () => ({ content: null, version: 0 }),
        updateSettings: async (req): Promise<AccountSettingsV2UpdateResponse> => {
          updates.push(req);
          return updates.length === 1
            ? { success: false, error: 'version-mismatch', currentVersion: 1,
              currentContent: { t: 'plain', v: { unknownField: 'preserved' } } }
            : { success: true, version: 2 };
        },
        writeCache: async () => {},
      },
    })).resolves.toEqual({ version: 2 });
    expect(updates).toEqual([
      { expectedVersion: 0, content: { t: 'plain', v: { example: 'nonempty' } } },
      { expectedVersion: 1, content: { t: 'plain', v: { unknownField: 'preserved', example: 'nonempty' } } },
    ]);
  });

  it('rejects encrypted settings without account key material before mutation', async () => {
    const mutate = vi.fn((settings: Readonly<Record<string, unknown>>) => ({ ...settings, hello: 'world' }));
    await expect(updateAccountSettingsV2WithRetry({
      credentials: { token: 'plain-token', encryption: null },
      mutate,
      deps: {
        fetchSettings: async () => ({ content: { t: 'encrypted', c: 'ciphertext' }, version: 5 }),
        updateSettings: vi.fn(),
      },
    })).rejects.toMatchObject({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses to read or rewrite plaintext settings when the environment requires E2EE', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'require_e2ee' });
    const updateSettings = vi.fn();
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        updateSettings,
      },
    })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('decrypts encrypted v2 content, applies mutation, and posts encrypted content back', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = { ...accountSettingsParse({ schemaVersion: 2 }), someKey: 'before' };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(10);
    expect(calls[0]?.content?.t).toBe('encrypted');

    const postedCiphertext = (calls[0]?.content as any)?.c ?? '';
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: postedCiphertext,
    });
    expect(opened?.value).toMatchObject({ someKey: 'after' });
  });

  it('preserves malformed untouched raw fields when posting encrypted content', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      someKey: 'before',
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toMatchObject({
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      someKey: 'after',
    });
  });

  it('preserves untouched raw fields when mutation returns sparse touched settings', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'before',
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: () => ({ someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toEqual({
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'after',
    });
  });

  it('consumes the protocol persisted object schema export at CLI runtime', () => {
    const parsed = AccountSettingsPersistedObjectSchema.safeParse({
      customFutureField: { preserved: true },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      customFutureField: { preserved: true },
    });
  });

  it('filters parser-materialized defaults from mutation results before posting', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({
        ...accountSettingsParse(settings),
        customFutureField: settings.customFutureField,
        someKey: 'after',
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toEqual({
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'after',
    });
  });

  it('skips the update when mutation output is semantically equal to the raw baseline', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });
    let updateCalls = 0;
    const writes: AccountSettingsCache[] = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => accountSettingsParse(settings),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          return { success: true, version: 11 };
        },
        writeCache: async (_path, cache) => {
          writes.push(cache);
        },
      },
    });

    expect(result.version).toBe(10);
    expect(updateCalls).toBe(0);
    expect(writes).toEqual([
      expect.objectContaining({
        settingsContent: { t: 'encrypted', c: initialCiphertext },
        settingsVersion: 10,
      }),
    ]);
  });

  it('posts sparse encrypted raw content without adding runtime defaults for an empty E2EE account', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: null,
          version: 0,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 1 };
        },
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: createLegacyCredentialsStub().encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toEqual({ someKey: 'after' });
  });

  it('does not post defaults when encrypted server settings cannot be opened', async () => {
    let updateCalls = 0;

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: 'not-valid-ciphertext' },
          version: 10,
        }),
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          return { success: true, version: 11 };
        },
      },
    })).rejects.toThrow('Failed to decrypt account settings ciphertext');

    expect(updateCalls).toBe(0);
  });

  it('retries version mismatches from current raw content without default-baking untouched fields', async () => {
    const credentials = createLegacyCredentialsStub();
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    let attempt = 0;

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 1,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          attempt += 1;
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          if (attempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 2,
              currentContent: {
                t: 'plain',
                v: {
                  schemaVersion: 2,
                  usageLimitRecoverySettingsV1: 'malformed-but-untouched',
                  otherKey: 'changed',
                },
              },
            };
          }
          return { success: true, version: 3 };
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.expectedVersion).toBe(1);
    expect(calls[1]?.expectedVersion).toBe(2);
    const retryContent = calls[1]?.content;
    expect(retryContent?.t).toBe('plain');
    if (retryContent?.t !== 'plain') throw new Error('expected plain retry content');
    expect(retryContent.v).toMatchObject({
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      otherKey: 'changed',
      hello: 'world',
    });
  });

  it('uses apiServerUrl for fetch and update requests when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        version: 5,
        content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 6 }) },
      },
    } as any);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { success: true, version: 6 },
    } as any);

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings) => ({ ...settings, hello: 'world' }),
    });

    expect(result.version).toBe(6);
    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        content: { t: 'plain', v: expect.objectContaining({ hello: 'world' }) },
        expectedVersion: 5,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });

  it('writes the refreshed disk cache under a credentials-derived path', async () => {
    const credentials = { ...createLegacyCredentialsStub(), token: 'token-account-a' };
    const writtenPaths: string[] = [];
    const resolveCachePath = vi.fn((pathCredentials: Credentials) => `/tmp/server/${pathCredentials.token}/account.settings.cache.json`);

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 6 }) },
          version: 5,
        }),
        updateSettings: async () => ({ success: true, version: 6 }),
        resolveCachePath,
        writeCache: async (path) => {
          writtenPaths.push(path);
        },
      },
    });

    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-account-a' }));
    expect(writtenPaths).toEqual(['/tmp/server/token-account-a/account.settings.cache.json']);
  });
});
