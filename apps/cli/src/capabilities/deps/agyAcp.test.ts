import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease.js';
import {
  __resetAgyAcpInFlightForTests,
  getAgyAcpDepStatus,
  installAgyAcp,
  resolveExistingAgyAcpManagedBinPath,
} from './agyAcp.js';

const testConfig = vi.hoisted(() => ({
  home: '',
  homeOnSeparateDevice: false,
  failNextPromotion: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (
        testConfig.failNextPromotion
        && basename(String(args[1])) === 'current'
        && !basename(String(args[0])).startsWith('previous-')
      ) {
        testConfig.failNextPromotion = false;
        throw Object.assign(new Error('Injected final promotion failure'), { code: 'EIO' });
      }
      // Model a mounted Happier home while keeping extraction and filesystem I/O real.
      const homePrefix = `${testConfig.home}${sep}`;
      if (testConfig.homeOnSeparateDevice
        && String(args[0]).startsWith(homePrefix) !== String(args[1]).startsWith(homePrefix)) {
        throw Object.assign(new Error('Cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.rename(...args);
    },
  };
});
vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() { return testConfig.home; },
    get logsDir() { return `${testConfig.home}/logs`; },
  },
}));

const tempDirs = new Set<string>();

function expectNoTransientInstallEntries(entries: readonly string[]): void {
  expect(entries).toContain('current');
  expect(entries).toContain('install-state.json');
  expect(entries.some((entry) => (
    entry === 'next'
    || entry === 'candidate'
    || entry.startsWith('.install-')
    || entry.startsWith('previous-')
  ))).toBe(false);
}

// Stored ZIPs with the official flat layout, using tiny executable and harness
// contents so installation exercises the real extractor without a network fetch.
const flatArchive = Buffer.from(process.platform === 'win32'
  ? 'UEsDBBQAAAAAAKCqIl2/ze6ZDgAAAA4AAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlc2VydmVyLWZpeHR1cmVQSwMEFAAAAAAAoKoiXeOBVF8PAAAADwAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhlaGFybmVzcy1maXh0dXJlUEsBAhQDFAAAAAAAoKoiXb/N7pkOAAAADgAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLmV4ZVBLAQIUAxQAAAAAAKCqIl3jgVRfDwAAAA8AAAAZAAAAAAAAAAAAAADtgT4AAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhlUEsFBgAAAAACAAIAhwAAAIQAAAAAAA=='
  : 'UEsDBBQAAAAAAKCqIl2/ze6ZDgAAAA4AAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyc2VydmVyLWZpeHR1cmVQSwMEFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxoYXJuZXNzLWZpeHR1cmVQSwECFAMUAAAAAACgqiJdv83umQ4AAAAOAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAAAAAAAAAAAAAO2BPgAAAGxvY2FsaGFybmVzc19leHRlcm5hbFBLBQYAAAAAAgACAIMAAACAAAAAAAA=',
  'base64');

afterEach(async () => {
  __resetAgyAcpInFlightForTests();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  testConfig.home = '';
  testConfig.homeOnSeparateDevice = false;
  testConfig.failNextPromotion = false;
});

describe('agy-acp-server installable (EU-3)', () => {
  it.each([false, true])('installs a flat ZIP and its companion (home on separate device: %s)', async (homeOnSeparateDevice) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-home-'));
    tempDirs.add(home);
    testConfig.home = home;
    testConfig.homeOnSeparateDevice = homeOnSeparateDevice;

    let downloadCalls = 0;
    const installed = await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => {
        downloadCalls += 1;
        await writeFile(destinationPath, flatArchive);
      },
    });
    expect(installed.ok, !installed.ok ? installed.errorMessage : undefined).toBe(true);
    expect(downloadCalls).toBe(1);

    const binPath = resolveExistingAgyAcpManagedBinPath();
    expect(binPath).not.toBeNull();
    expect(await readFile(binPath!, 'utf8')).toBe('server-fixture');
    const companionName = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external';
    expect(await readFile(join(home, 'tools', 'agy-acp-server', 'current', companionName), 'utf8'))
      .toBe('harness-fixture');

    const status = await getAgyAcpDepStatus();
    expect(status.installed).toBe(true);
    expect(status.binPath).toBe(binPath);
    expect(status.installedVersion).toBe('1.1.1');
    expectNoTransientInstallEntries(await readdir(status.installDir));
  });

  it('rejects a managed executable whose contents changed after verified installation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-corrupt-'));
    tempDirs.add(home);
    testConfig.home = home;

    const installed = await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => {
        await writeFile(destinationPath, 'mock-agy-archive', 'utf8');
      },
      extractArchive: async ({ extractDir }) => {
        const asset = resolveAgyAcpReleaseAsset();
        await mkdir(extractDir, { recursive: true });
        const executablePath = join(extractDir, asset.executableSubpath);
        await mkdir(join(executablePath, '..'), { recursive: true });
        await writeFile(executablePath, '#!/bin/sh\necho agy_acp_server\n', 'utf8');
      },
    });
    expect(installed.ok).toBe(true);

    const binPath = resolveExistingAgyAcpManagedBinPath();
    expect(binPath).not.toBeNull();
    await writeFile(binPath!, '#!/bin/sh\necho tampered\n', 'utf8');

    const status = await getAgyAcpDepStatus();
    expect(status.installed).toBe(false);
    expect(status.binPath).toBeNull();
  });

  it('forwards the pinned release extraction budget to the archive extractor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-limits-'));
    tempDirs.add(home);
    testConfig.home = home;
    const asset = resolveAgyAcpReleaseAsset();
    const extractArchive = vi.fn(async ({ extractDir }: { extractDir: string }) => {
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, asset.executableSubpath), 'server-fixture', 'utf8');
    });

    const installed = await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => {
        await writeFile(destinationPath, 'archive-fixture', 'utf8');
      },
      extractArchive,
    });

    expect(installed.ok, !installed.ok ? installed.errorMessage : undefined).toBe(true);
    expect(extractArchive).toHaveBeenCalledWith(expect.objectContaining({
      limits: asset.archiveExtractionLimits,
    }));
  });

  it('cleans failed staging without removing the installed server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-failed-update-'));
    tempDirs.add(home);
    testConfig.home = home;

    expect((await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => { await writeFile(destinationPath, flatArchive); },
    })).ok).toBe(true);
    const installedBinPath = resolveExistingAgyAcpManagedBinPath();

    const failed = await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => { await writeFile(destinationPath, 'invalid ZIP'); },
    });
    expect(failed.ok).toBe(false);
    const status = await getAgyAcpDepStatus();
    expect(status.installed).toBe(true);
    expect(status.binPath).toBe(installedBinPath);
    expect(await readFile(status.binPath!, 'utf8')).toBe('server-fixture');
    expectNoTransientInstallEntries(await readdir(status.installDir));
  });

  it('restores the installed server when final promotion fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-failed-promotion-'));
    tempDirs.add(home);
    testConfig.home = home;

    expect((await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => { await writeFile(destinationPath, flatArchive); },
    })).ok).toBe(true);
    const installedBinPath = resolveExistingAgyAcpManagedBinPath();
    expect(installedBinPath).not.toBeNull();
    const statePath = join(home, 'tools', 'agy-acp-server', 'install-state.json');
    const previousState = JSON.parse(await readFile(statePath, 'utf8'));

    testConfig.failNextPromotion = true;
    const failed = await installAgyAcp({
      downloadArchive: async ({ destinationPath }) => { await writeFile(destinationPath, 'replacement-archive'); },
      extractArchive: async ({ extractDir }) => {
        const asset = resolveAgyAcpReleaseAsset();
        await mkdir(extractDir, { recursive: true });
        await writeFile(join(extractDir, asset.executableSubpath), 'replacement-server', 'utf8');
      },
    });

    expect(failed.ok).toBe(false);
    const status = await getAgyAcpDepStatus();
    expect(status.installed).toBe(true);
    expect(status.binPath).toBe(installedBinPath);
    expect(await readFile(status.binPath!, 'utf8')).toBe('server-fixture');
    const restoredState = JSON.parse(await readFile(statePath, 'utf8'));
    expect(restoredState).toMatchObject({
      installedVersion: previousState.installedVersion,
      executableSha256: previousState.executableSha256,
      executableSize: previousState.executableSize,
      executableMtimeMs: previousState.executableMtimeMs,
    });
    expectNoTransientInstallEntries(await readdir(status.installDir));
  });

  it('coalesces concurrent installs into one download', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-coalesce-'));
    tempDirs.add(home);
    testConfig.home = home;
    let downloadCalls = 0;
    let extractCalls = 0;
    const deps = {
      downloadArchive: async ({ destinationPath }: { destinationPath: string }) => {
        downloadCalls += 1;
        await writeFile(destinationPath, 'mock-agy-archive', 'utf8');
      },
      extractArchive: async ({ extractDir }: { extractDir: string }) => {
        extractCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const asset = resolveAgyAcpReleaseAsset();
        await mkdir(extractDir, { recursive: true });
        await writeFile(join(extractDir, asset.executableSubpath), 'bin', 'utf8');
      },
    };

    const [first, second] = await Promise.all([installAgyAcp(deps), installAgyAcp(deps)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(extractCalls).toBe(1);
    expect(downloadCalls).toBe(1);
  });

  it('fails clearly on unsupported platforms', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-unsupported-'));
    tempDirs.add(home);
    testConfig.home = home;
    // Unsupported platform selection itself throws in the release owner.
    expect(() => resolveAgyAcpReleaseAsset({ platform: 'darwin', arch: 'x64' })).toThrow(/unsupported/i);
    expect(resolveExistingAgyAcpManagedBinPath()).toBeNull();
  });
});
