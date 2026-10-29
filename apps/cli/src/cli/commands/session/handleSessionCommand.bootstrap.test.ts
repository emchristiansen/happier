import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
// Keep the HTTP replacement installed through module resets and timed-out test cleanup.
// No test path may fall through to a real request.
const { httpGet } = vi.hoisted(() => ({ httpGet: vi.fn() }));
vi.mock('axios', async () => {
  const { createOfflineAxios } = await import('@/testkit/http/offlineAxios');
  return { default: createOfflineAxios(httpGet) };
});


const credentials: Credentials = {
  token: 'session-settings-test',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

describe('handleSessionCommand account settings bootstrap', () => {
  let home: string;
  beforeEach(async () => {
    vi.resetModules();
    httpGet.mockReset().mockRejectedValue(new Error('Unconfigured offline HTTP boundary'));
    vi.stubEnv('HAPPIER_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://relay.example.invalid');
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', '');
    home = await mkdtemp(join(tmpdir(), 'session-settings-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '300000');
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function runList(cachedAt: number) {
    const { resolveAccountSettingsCachePath, writeAccountSettingsCacheAtomic } = await import('@/settings/accountSettings/accountSettingsCache');
    const { getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    await writeAccountSettingsCacheAtomic(resolveAccountSettingsCachePath(credentials), {
      version: 2, cachedAt, settingsVersion: 3,
      settingsContent: { t: 'plain', v: { schemaVersion: 6 } },
    });
    let settingsReads = 0;
    const get = httpGet.mockImplementation(async (url: string) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/v2/account/settings') {
        settingsReads += 1;
        return { status: 200, data: { content: { t: 'plain', v: { schemaVersion: 6 } }, version: 4 } };
      }
      if (pathname === '/v2/sessions') {
        return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      }
      throw new Error(`Unexpected test HTTP request: ${String(url)}`);
    });
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();
    try {
      await handleSessionCommand(['list', '--json'], { readCredentialsFn: async () => credentials });
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, kind: 'session_list' });
    } finally { output.restore(); }
    return { settingsReads, get, active: getActiveAccountSettingsSnapshot() };
  }

  it('runs an ordinary session command from fresh account cache without a settings request', async () => {
    const result = await runList(Date.now() - 1_000);
    expect(result.settingsReads).toBe(0);
    expect(result.active).toMatchObject({ settingsVersion: 3, source: 'cache' });
  });

  it('fetches stale settings before the session command runs', async () => {
    const result = await runList(Date.now() - 300_001);
    expect(result.settingsReads).toBe(1);
    expect(result.active).toMatchObject({ settingsVersion: 4, source: 'network' });
    expect(result.get.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').slice(-2).join('/')))
      .toEqual(['account/settings', 'v2/sessions']);
  });

  it('keeps MODE=never free of settings requests even with stale cache', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    const result = await runList(0);
    expect(result.settingsReads).toBe(0);
    expect(result.active).toMatchObject({ settingsVersion: 0, source: 'none' });
  });
});
