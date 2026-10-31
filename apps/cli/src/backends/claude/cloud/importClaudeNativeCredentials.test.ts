import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';
import { claudeCloudConnect } from './connect';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const SCOPES = ['user:inference', 'user:profile', 'user:sessions:claude_code'];

describe('Claude native credential import', () => {
  let homeDir: string;
  let credentialPath: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-import-'));
    credentialPath = join(homeDir, '.credentials.json');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', homeDir);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fetchSpy = vi.fn(() => { throw new Error('Native credential import must not contact OAuth endpoints'); });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function writeCredential(overrides: Record<string, unknown> = {}) {
    await writeFile(credentialPath, JSON.stringify({ claudeAiOauth: {
      accessToken: 'native-access', refreshToken: 'native-refresh', expiresAt: NOW + 3_600_000,
      scopes: SCOPES, subscriptionType: 'max', rateLimitTier: 'max_20x', ...overrides,
    } }));
  }

  function importNative(signal?: AbortSignal) {
    const hook = claudeCloudConnect.importCredentials;
    if (!hook) throw new Error('Claude native credential import is unavailable');
    return hook({ source: 'native', signal });
  }

  it('imports the configured native OAuth grant and entitlement through the existing record builder without mutating or refreshing it', async () => {
    await writeCredential();
    await writeFile(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: {
      accountUuid: 'stale-account', emailAddress: 'stale@example.test',
    } }));
    const before = await readFile(credentialPath, 'utf8');
    const oauth = await importNative();
    const record = buildConnectedServiceCredentialRecord({
      serviceId: 'claude-subscription', profileId: 'imported', kind: 'oauth', now: NOW,
      expiresAt: NOW + 3_600_000,
      oauth: { accessToken: 'native-access', refreshToken: 'native-refresh', idToken: null,
        scope: SCOPES.join(' '), tokenType: 'Bearer', providerAccountId: null, providerEmail: null,
        raw: normalizeConnectedServiceOauthCredentialRawMetadata(oauth, 'claude-subscription') },
    });
    expect(oauth).toMatchObject({ access_token: 'native-access', refresh_token: 'native-refresh',
      expires_in: 3600, token_type: 'Bearer', scope: SCOPES.join(' ') });
    expect(record.kind === 'oauth' && record.oauth.raw).toMatchObject({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'max_20x' },
    });
    expect(oauth).not.toHaveProperty('account');
    expect(await readFile(credentialPath, 'utf8')).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing refresh token', { refreshToken: undefined }],
    ['expired access token', { expiresAt: NOW }],
    ['unknown access-token expiry', { expiresAt: undefined }],
    ['setup-token scope', { scopes: ['user:inference'] }],
  ])('refuses %s without changing the native credential', async (_label, overrides) => {
    await writeCredential(overrides);
    const before = await readFile(credentialPath, 'utf8');
    await expect(importNative()).rejects.toMatchObject({ name: 'ConnectedServiceImportError', code: 'reauthorization_required' });
    expect(await readFile(credentialPath, 'utf8')).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses missing native credentials with a safe typed error', async () => {
    await expect(importNative()).rejects.toMatchObject({ name: 'ConnectedServiceImportError', code: 'credentials_unavailable' });
  });

  it('honors cancellation before reading credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(importNative(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses unrecognized sources before reading credentials', async () => {
    const hook = claudeCloudConnect.importCredentials;
    if (!hook) throw new Error('Claude native credential import is unavailable');
    await expect(hook({ source: 'other' })).rejects.toMatchObject({
      name: 'ConnectedServiceImportError', code: 'unsupported_source',
    });
  });
});
