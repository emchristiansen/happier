import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { withTempDir } from '@/testkit/fs/tempDir';
import { installDaemonService, previewDaemonServiceInstall } from './installer';
import { planDaemonServiceInstall } from './plan';

describe('launchd install reloads a changed CLI definition', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['RunAtLoad', 'KeepAlive'] as const)('repairs explicit on-demand %s drift with an unchanged marker and launcher', async (trigger) => {
    await withTempDir('happier-service-trigger-repair-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
      const options = {
        platform: 'darwin' as const, mode: 'user' as const, channel: 'stable' as const,
        targetMode: 'pinned' as const, instanceId: 'company', activeServerId: 'company',
        uid: 501, userHomeDir, happierHomeDir,
        serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test', nodePath: '/npm/happier', entryPath: '',
        autostart: 'on-demand' as const, darwinInstallMode: 'kickstart' as const,
      };
      const expected = planDaemonServiceInstall(options).files[0]!;
      const drifted = trigger === 'RunAtLoad'
        ? expected.content.replace('<key>RunAtLoad</key>\n    <false/>', '<key>RunAtLoad</key>\n    <true/>')
        : expected.content.replace('<key>RunAtLoad</key>', '<key>KeepAlive</key>\n    <dict><key>SuccessfulExit</key><false/></dict>\n    <key>RunAtLoad</key>');
      expect(drifted).not.toBe(expected.content);
      mkdirSync(dirname(expected.path), { recursive: true });
      writeFileSync(expected.path, drifted);
      const preview = await previewDaemonServiceInstall(options);
      expect(preview.exactTargetIsConverged).toBe(true);
      expect(preview.exactTargetRuntimeReplacement).toBeNull();
      expect(preview.exactTargetMatchesExpectedDefinition).toBe(false);
      expect(preview.plan.commands.some((command) => command.args[0] === 'bootstrap')).toBe(true);
      const beforeApply = vi.fn(async () => {});
      await installDaemonService({ ...options, runCommands: false, beforeApply });
      expect(beforeApply).toHaveBeenCalledTimes(1);
      expect(readFileSync(expected.path, 'utf8')).toBe(expected.content);
      // The corrected definition stays a no-op; no further apply or launcher change is needed.
      await installDaemonService({ ...options, runCommands: false, beforeApply });
      expect(beforeApply).toHaveBeenCalledTimes(1);
    });
  });

  it('reloads a CLI choice change even when the existing service is running', async () => {
    await withTempDir('happier-service-launchd-reload-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
      const managedLauncher = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli', channel: 'stable', processEnv: process.env,
      }).shimPaths[0]!;
      const options = {
        platform: 'darwin' as const, mode: 'user' as const, channel: 'stable' as const,
        targetMode: 'pinned' as const, instanceId: 'company', activeServerId: 'company',
        uid: 501, userHomeDir, happierHomeDir,
        serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test', nodePath: '/npm/happier', entryPath: '',
      };
      const installed = planDaemonServiceInstall(options).files[0]!;
      mkdirSync(dirname(installed.path), { recursive: true });
      writeFileSync(installed.path, installed.content);

      const preview = await previewDaemonServiceInstall({
        ...options, nodePath: managedLauncher, darwinInstallMode: 'kickstart',
      });
      expect(preview.exactTargetExists).toBe(true);
      expect(preview.plan.commands.some((command) => command.args[0] === 'bootstrap')).toBe(true);

      // An unchanged loaded definition can keep the ordinary kickstart path.
      const unchanged = await previewDaemonServiceInstall({ ...options, darwinInstallMode: 'kickstart' });
      expect(unchanged.plan.commands.map((command) => command.args[0])).toEqual(['kickstart']);

      const staleRunningDaemon = await previewDaemonServiceInstall({
        ...options,
        darwinInstallMode: 'kickstart',
        restartRunningDaemon: true,
      });
      expect(staleRunningDaemon.plan.commands.some((command) => command.args[0] === 'bootstrap')).toBe(true);
    });
  });
});
