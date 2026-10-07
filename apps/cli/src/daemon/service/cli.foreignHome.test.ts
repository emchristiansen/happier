import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { planDaemonServiceInstall } from './plan';

// Service manager invocations are the OS boundary. Every definition and ownership check is real.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_PLATFORM', 'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE', 'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
]);

afterEach(() => { envScope.restore(); vi.resetModules(); spawnSyncMock.mockReset(); });

describe('service definition home attribution', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('refuses foreign default definitions on %s', async (platform) => {
    await withTempDir('w23-foreign-service-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, 'qa-home');
      const foreignHomeDir = join(userHomeDir, 'foreign-home');
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: platform,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });
      const foreignPlan = planDaemonServiceInstall({
        platform, mode: 'user', channel: 'stable', targetMode: 'default-following',
        instanceId: 'cloud', activeServerId: 'cloud', userHomeDir, happierHomeDir: foreignHomeDir,
        nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', uid: 501,
        serverUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test',
        publicServerUrl: 'https://relay.example.test', autostart: 'at-login',
      });
      const definition = foreignPlan.files[0]!;
      mkdirSync(dirname(definition.path), { recursive: true });
      writeFileSync(definition.path, definition.content);
      spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => ({
        status: 0, stderr: '', stdout: args.includes('/XML')
          ? `<Task><Actions><Exec><Arguments>-File &quot;${definition.path}&quot;</Arguments></Exec></Actions></Task>`
          : args.includes('CSV') ? '"\\Happier\\happier-daemon.default","N/A","Ready"' : '',
      }));
      const cli = await import('./cli');
      expect(cli.resolveDaemonServiceInstallationSnapshotFromEnv()).toMatchObject({
        installed: false, autostart: null, targetMode: null,
      });
      for (const action of ['stop', 'start', 'restart', 'uninstall'] as const) {
        await expect(cli.runDaemonServiceCliCommand({ argv: [action, '--json'] })).rejects.toMatchObject({
          code: 'foreign_home_service',
        });
      }
      expect(spawnSyncMock.mock.calls.every(([, args]) => args.includes('/Query'))).toBe(true);
      const runtime = cli.resolveDaemonServiceCliRuntimeFromEnv();
      mkdirSync(foreignHomeDir, { recursive: true });
      writeFileSync(join(foreignHomeDir, 'settings.json'), JSON.stringify({
        activeServerId: 'cloud', servers: { cloud: { id: 'cloud', serverUrl: runtime.serverUrl } },
      }));
      const { resolveInstalledDaemonServiceInventoryForCurrentRelay, hasInstalledBackgroundServiceConflictForCurrentInstallation } = await import('../ownership/daemonServiceInventory');
      expect(await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime)).toEqual([]);
      expect(hasInstalledBackgroundServiceConflictForCurrentInstallation({
        runtime, services: await cli.resolveDaemonServiceListEntries(runtime),
      })).toBe(false);
      const { planServiceDaemonsRestartAfterUpdate } = await import('../../cli/runtime/update/restartServiceDaemonAfterUpdate');
      expect(await planServiceDaemonsRestartAfterUpdate({ channel: 'stable' })).toMatchObject({ labels: [], restart: null });
      const ownPlan = planDaemonServiceInstall({
        platform, mode: 'user', channel: 'stable', targetMode: 'default-following',
        instanceId: runtime.instanceId, activeServerId: runtime.activeServerId,
        userHomeDir, happierHomeDir, nodePath: process.execPath, entryPath: '/opt/happier/index.mjs',
        uid: 501, serverUrl: runtime.serverUrl, webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl, autostart: 'on-demand',
      });
      // Windows' registered task is authoritative even if the invoking home's wrapper differs.
      writeFileSync(definition.path, ownPlan.files[0]!.content);
      expect(cli.resolveDaemonServiceInstallationSnapshotFromEnv()).toMatchObject({
        installed: true, autostart: 'on-demand', targetMode: 'default-following',
      });
      if (platform === 'win32') {
        // A stale local wrapper must not authorize a global task pointing at an unowned script.
        const localDefinition = ownPlan.files[0]!;
        mkdirSync(dirname(localDefinition.path), { recursive: true });
        writeFileSync(localDefinition.path, localDefinition.content);
        writeFileSync(definition.path, 'Write-Output "unowned task"');
        spawnSyncMock.mockClear();
        expect(cli.resolveDaemonServiceInstallationSnapshotFromEnv().installed).toBe(false);
        for (const action of ['stop', 'start', 'restart', 'uninstall'] as const) {
          await expect(cli.runDaemonServiceCliCommand({ argv: [action, '--json'] })).rejects.toMatchObject({
            code: 'foreign_home_service',
          });
        }
        expect(spawnSyncMock.mock.calls.every(([, args]) => args.includes('/Query'))).toBe(true);
      }
    });
  });
});
