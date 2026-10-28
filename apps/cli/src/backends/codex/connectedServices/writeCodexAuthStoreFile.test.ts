import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

describe('writeCodexAuthStoreFile', () => {
  it('writes last_refresh as RFC 3339 — codex-cli >= 0.142 rejects epoch numbers (published contract)', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-auth-store-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 2_000_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    await writeCodexAuthStoreFile({ codexHome, record });

    const written = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')) as {
      last_refresh: unknown;
      tokens: { account_id: unknown };
    };
    // A mid-June 2026 writer regression stored epoch millis here, which codex-cli 0.142.3
    // rejects at parse time — every direct spawn from a managed home failed. Pin the contract.
    expect(typeof written.last_refresh).toBe('string');
    expect(written.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
    expect(Number.isNaN(Date.parse(written.last_refresh as string))).toBe(false);
    expect(written.tokens.account_id).toBe('acct');

    // A native disk-auth client may rotate its tokens while Happier's stored source is unchanged.
    // Starting a second session must not replace the newer native projection with that source.
    const nativeAuth = {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'native-access', refresh_token: 'native-refresh', id_token: 'id', account_id: 'acct' },
      last_refresh: new Date().toISOString(),
    };
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify(nativeAuth));
    await writeCodexAuthStoreFile({ codexHome, record });
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('native-refresh');

    // The same source still repairs historical poison, missing files, and another account.
    // This launch-time owner makes a separate startup scan unnecessary for disk-auth recovery.
    for (const damaged of [
      '{malformed',
      JSON.stringify({ ...nativeAuth, last_refresh: 1_000_000 }),
      JSON.stringify({ ...nativeAuth, tokens: { ...nativeAuth.tokens, account_id: 'other-account' } }),
      JSON.stringify({ ...nativeAuth, tokens: { ...nativeAuth.tokens, refresh_token: '' } }),
      JSON.stringify({ auth_mode: 'chatgpt', ...nativeAuth.tokens, last_refresh: nativeAuth.last_refresh }),
      null,
    ]) {
      if (damaged === null) await rm(join(codexHome, 'auth.json'));
      else await writeFile(join(codexHome, 'auth.json'), damaged);
      await writeCodexAuthStoreFile({ codexHome, record });
      expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))).toMatchObject({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'access', refresh_token: 'refresh', account_id: 'acct' },
      });
    }

    if (record.kind !== 'oauth') throw new Error('Expected OAuth fixture');
    const refreshedSource = buildConnectedServiceCredentialRecord({
      ...record,
      now: 2_000_000,
      oauth: { ...record.oauth, raw: null, accessToken: 'source-access-two', refreshToken: 'source-refresh-two' },
    });
    await writeCodexAuthStoreFile({ codexHome, record: refreshedSource });
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('source-refresh-two');
  });
});
