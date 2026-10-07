import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INSTALLABLE_KEYS } from '@happier-dev/protocol';
import {
  __resetAgyAcpInFlightForTests,
  installAgyAcp,
  resolveExistingAgyAcpManagedBinPath,
} from '@/capabilities/deps/agyAcp';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';

const testConfig = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() { return testConfig.home; },
    get logsDir() { return `${testConfig.home}/logs`; },
  },
}));

beforeEach(async () => {
  testConfig.home = await mkdtemp(join(tmpdir(), 'happier-agy-runtime-installable-'));
});

afterEach(async () => {
  __resetAgyAcpInFlightForTests();
  if (testConfig.home) await rm(testConfig.home, { recursive: true, force: true });
  testConfig.home = '';
});

describe('agy-acp-server runtime installable (EU-3)', () => {
  it('authoritatively ensures the managed server for launch when missing', async () => {
    const { getRuntimeInstallableAdapter } = await import('./runtimeInstallablesRegistry.js');
    const adapter = await getRuntimeInstallableAdapter(INSTALLABLE_KEYS.AGY_ACP_SERVER);
    expect(adapter.key).toBe(INSTALLABLE_KEYS.AGY_ACP_SERVER);
    const resolution = await adapter.detectLaunchResolution();
    expect(typeof resolution.canAutoInstall).toBe('boolean');
  });

  it('joins concurrent prewarm and launch ensures into one install', async () => {
    const { ensureRuntimeInstallablesForLaunch } = await import('./ensureRuntimeInstallablesForLaunch.js');
    const { INSTALLABLE_KEYS: KEYS } = await import('@happier-dev/protocol');
    const { accountSettingsParse } = await import('@happier-dev/protocol');

    let downloadCalls = 0;
    let extractCalls = 0;
    const installDeps = {
      downloadArchive: async ({ destinationPath }: { destinationPath: string }) => {
        downloadCalls += 1;
        await writeFile(destinationPath, 'mock-agy-archive', 'utf8');
      },
      extractArchive: async ({ extractDir }: { extractDir: string }) => {
        extractCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const asset = resolveAgyAcpReleaseAsset();
        await mkdir(extractDir, { recursive: true });
        await writeFile(join(extractDir, asset.executableSubpath), 'bin', 'utf8');
      },
    };
    const fakeAdapter = {
      key: KEYS.AGY_ACP_SERVER,
      detectLaunchResolution: vi.fn(async () => resolveExistingAgyAcpManagedBinPath()
        ? { availability: { ok: true as const }, canAutoInstall: false, canBackgroundAutoUpdate: false }
        : { availability: { ok: false as const, errorMessage: 'missing' }, canAutoInstall: true, canBackgroundAutoUpdate: false }),
      installOrUpgrade: vi.fn(async () => await installAgyAcp(installDeps)),
      runBackgroundAutoUpdateCheck: vi.fn(async () => {}),
    };

    const params = {
      installableKeys: [KEYS.AGY_ACP_SERVER] as const,
      settings: accountSettingsParse({}),
      machineId: 'machine-agy-1',
    } as never;
    const deps = { getRuntimeInstallableAdapter: async () => fakeAdapter } as never;
    const [first, second] = await Promise.all([
      ensureRuntimeInstallablesForLaunch(params, deps),
      ensureRuntimeInstallablesForLaunch(params, deps),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(fakeAdapter.installOrUpgrade).toHaveBeenCalledTimes(2);
    expect(downloadCalls).toBe(1);
    expect(extractCalls).toBe(1);
  });
});
