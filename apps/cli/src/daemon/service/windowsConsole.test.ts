import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';

const { spawnSyncMock, spawnMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn(), spawnMock: vi.fn() }));
// Keep command resolution, CLI launch specifications and service discovery real beneath the OS boundary.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));

import { runDaemonServiceCommands } from './apply';
import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { resolveCliVersionFromBinary } from './resolveCliVersionFromBinary';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

describe('Windows background CLI process consoles', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const envScope = createSpawnHappyCliEnvScope();
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    envScope.restore();
    vi.unstubAllEnvs();
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
  });

  it('hides scheduler lifecycle, inventory and installed-version probes', async () => {
    await withTempDir('happier-cli-console-', async (directory) => {
      for (const name of ['powershell.exe', 'schtasks.exe', 'happier.exe']) writeFileSync(join(directory, name), '');
      mkdirSync(join(directory, '.happier', 'services'), { recursive: true });
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      vi.stubEnv('PATH', directory);
      spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
      runDaemonServiceCommands([
        { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Stop-ScheduledTask'] },
        { cmd: 'schtasks', args: ['/Run', '/TN', 'Happier\\happier-daemon.default'] },
      ], { failureMode: 'strict' });
      expect(await discoverInstalledDaemonServiceEntries({
        platform: 'win32', mode: 'user', userHomeDir: directory,
        happierHomeDir: join(directory, '.happier'), serversById: {},
      })).toEqual([]);
      spawnSyncMock.mockReturnValue({ status: 0, stdout: '0.2.15\n', stderr: '' });
      expect(resolveCliVersionFromBinary({ binaryPath: join(directory, 'happier.exe'), platform: 'win32' })).toBe('0.2.15');
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
      for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
    });
  });

  it('hides background CLI children while retaining an explicit interactive visibility choice', async () => {
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint });
      spawnHappyCLI(['daemon', 'start-sync'], { stdio: 'ignore' });
      expect(spawnMock.mock.calls[0]?.[2].windowsHide).toBe(true);
      spawnHappyCLI(['daemon', 'start-sync'], { stdio: 'ignore', windowsHide: undefined });
      expect(spawnMock.mock.calls[1]?.[2].windowsHide).toBe(true);
      spawnHappyCLI(['auth', 'login'], { stdio: 'inherit', windowsHide: false });
      expect(spawnMock.mock.calls[2]?.[2].windowsHide).toBe(false);
    });
  });

  it('keeps repeated desktop service status commands hidden when this computer has no daemon', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-status-console-', env: {
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      for (const name of ['schtasks.exe', 'powershell.exe']) writeFileSync(join(homeDir, name), '');
      vi.stubEnv('PATH', homeDir);
      mkdirSync(join(homeDir, 'services'), { recursive: true });
      spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
      const { runDaemonServiceCliCommand } = await import('./cli');
      const output = captureStdoutJsonOutput<{ ok: boolean; daemon: { running: boolean } }>();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await runDaemonServiceCliCommand({ argv: ['status', '--json'] });
          expect(output.json().daemon.running).toBe(false);
          output.chunks.length = 0;
        }
        expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
        for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
      } finally {
        output.restore();
      }
    });
  });
});
