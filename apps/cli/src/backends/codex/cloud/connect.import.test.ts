import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexCloudConnect } from './connect';

describe('Codex cloud native credential import', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns the existing OAuth payload from the native account without changing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-cloud-import-'));
    dirs.push(dir);
    vi.stubEnv('CODEX_HOME', dir);
    const native = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      id_token: 'native-id', access_token: 'native-access', refresh_token: 'native-refresh', account_id: 'native-account',
    } });
    await writeFile(join(dir, 'auth.json'), native);
    const payload = await codexCloudConnect.importCredentials!({ source: 'native' });
    expect(payload).toEqual({
      id_token: 'native-id', access_token: 'native-access', refresh_token: 'native-refresh',
      account_id: 'native-account', expires_at: null,
    });
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(native);
  });

  it('refuses unsupported import sources', async () => {
    await expect(codexCloudConnect.importCredentials!({ source: 'other' })).rejects.toMatchObject({
      code: 'unsupported_source',
    });
  });
});
