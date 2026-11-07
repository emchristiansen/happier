import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readCodexEnvironmentAuthState,
  readCodexEnvironmentAuthTokens,
  readCodexNativeAuthCredentials,
} from './readCodexEnvironmentAuthState';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('readCodexEnvironmentAuthState', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('ignores expired credentials-file tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'expired@example.test', exp: 1 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthState({ HOME: dir, USERPROFILE: dir })).toEqual({
      method: null,
      accountLabel: null,
    });
  });

  it('accepts unexpired credentials-file tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthState({ HOME: dir, USERPROFILE: dir })).toEqual({
      method: 'credentials_file',
      accountLabel: 'valid@example.test',
    });
  });

  it('reads unexpired Codex auth tokens and ChatGPT account id for provider APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-tokens-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'valid@example.test', exp: 4_102_444_800 }),
          account_id: 'acct-native',
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthTokens({ HOME: dir, USERPROFILE: dir })).toEqual({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      accountId: 'acct-native',
      accountLabel: 'valid@example.test',
    });
  });

  it('accepts CODEX_API_KEY env auth without an auth file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-'));
    tempDirs.push(dir);

    expect(readCodexEnvironmentAuthState({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_API_KEY: 'codex-test-key',
    })).toEqual({
      method: 'api_key_env',
      accountLabel: null,
    });
  });

  it('expands ~/ CODEX_HOME against the provided HOME before reading auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-auth-state-home-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'scoped-codex-home'), { recursive: true });
    await writeFile(
      join(dir, 'scoped-codex-home', 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'scoped@example.test', exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );

    expect(readCodexEnvironmentAuthState({
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: '~/scoped-codex-home',
    })).toEqual({
      method: 'credentials_file',
      accountLabel: 'scoped@example.test',
    });
  });

  it('imports native ChatGPT tokens without refreshing or rewriting the native file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-import-'));
    tempDirs.push(dir);
    const idToken = buildJwt({ email: 'native@example.test', exp: 1 });
    const accessToken = buildJwt({ exp: 4_102_444_800 });
    const original = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'refresh-native', account_id: 'acct-native' },
    });
    await writeFile(join(dir, 'auth.json'), original);

    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).resolves.toEqual({
      idToken, accessToken, refreshToken: 'refresh-native', accountId: 'acct-native', expiresAt: 4_102_444_800_000,
    });
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(original);
  });

  it('respects configured keyring storage instead of importing a stale auth file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-keyring-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: 'stale-id', access_token: 'stale-access', refresh_token: 'stale-refresh', account_id: 'stale-account',
    } }));
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin',
      readKeyring: async ({ service, account }) => {
        expect(service).toBe('Codex Auth');
        expect(account).toBe(`cli|${createHash('sha256').update(await realpath(dir)).digest('hex').slice(0, 16)}`);
        return JSON.stringify({ tokens: {
        id_token: 'native-id', access_token: 'native-access', refresh_token: 'native-refresh', account_id: 'native-account',
        } });
      },
    })).resolves.toMatchObject({ accessToken: 'native-access', accountId: 'native-account' });
  });

  it('derives the native account from its ID token when Codex omits optional account_id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-jwt-account-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: buildJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-native-account' } }),
      access_token: buildJwt({ exp: 4_102_444_800 }), refresh_token: 'native-refresh',
    } }));
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).resolves.toMatchObject({
      accountId: 'jwt-native-account',
    });
  });

  it('rejects expired access rather than treating a valid identity token as usable access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-expired-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: buildJwt({ exp: 4_102_444_800 }), access_token: buildJwt({ exp: 1 }),
      refresh_token: 'refresh', account_id: 'account',
    } }));
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
  });

  it('rejects Windows encrypted and ephemeral storage without borrowing the file login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-unavailable-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir }, platform: 'win32' })).rejects.toMatchObject({
      code: 'credentials_unavailable',
    });
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n');
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      code: 'credentials_unavailable',
    });
  });

  it('honors Codex secret_auth_storage on Linux instead of consulting a direct keyring login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-secrets-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true\n');
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'linux', readKeyring: async () => JSON.stringify({ tokens: {
        id_token: 'wrong-store-id', access_token: 'wrong-store-access', refresh_token: 'refresh', account_id: 'account',
      } }),
    })).rejects.toMatchObject({ code: 'credentials_unavailable' });
  });

  it('imports the file fallback only when auto storage has no keyring entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-auto-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: 'file-id', access_token: 'file-access', refresh_token: 'file-refresh', account_id: 'file-account',
    } }));
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin', readKeyring: async () => null,
    })).resolves.toMatchObject({ accountId: 'file-account' });
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin', readKeyring: async () => '{secret-malformed',
    })).rejects.toMatchObject({ code: 'reauthorization_required' });
  });

  it('rejects non-OAuth records and cancellation with credential-free errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-errors-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'private-api-key' }));
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'private-api-key', tokens: {
      id_token: 'hidden-id', access_token: 'hidden-access', refresh_token: 'hidden-refresh', account_id: 'hidden-account',
    } }));
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    const abort = new AbortController();
    abort.abort(new Error('private-secret-abort-reason'));
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir }, signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError', message: 'Credential import cancelled',
    });
  });
});
