import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { clearDaemonStateForTests } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

/**
 * The status projection must carry the installed service's *autostart mode*, in the CLI's own
 * `at-login | on-demand` vocabulary. It is the only way a reader can tell "this computer keeps
 * answering after the app closes" from "it stops". `null` is UNKNOWN — a definition that declares
 * nothing, or no readable definition at all — and never means `at-login`: claiming a login trigger
 * nobody proved is exactly the guess that takes a machine off the air silently.
 */

const ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_AUTOSTART',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
] as const;

function writeInstalledUnit(declaredAutostart: string | null): string {
  const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
  mkdirSync(dirname(snapshot.installedPath), { recursive: true });
  writeFileSync(snapshot.installedPath, [
    '[Service]',
    'ExecStart=/opt/happier/happier daemon start-sync',
    'Environment=HAPPIER_DAEMON_STARTUP_SOURCE=background-service',
    `Environment=HAPPIER_HOME_DIR=${process.env.HAPPIER_HOME_DIR}`,
    'Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following',
    ...(declaredAutostart === null
      ? []
      : [`Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=${declaredAutostart}`]),
    '',
  ].join('\n'));
  return snapshot.installedPath;
}

describe('readDaemonStatusSnapshot service.autostart', () => {
  let envScope = createEnvKeyScope([...ENV_KEYS]);
  let tmpHomeDir: string | null = null;

  beforeEach(async () => {
    tmpHomeDir = await createTempDir('happier-status-service-autostart-');
    envScope.patch({
      HAPPIER_HOME_DIR: tmpHomeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmpHomeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: tmpHomeDir,
    });
    reloadConfiguration();
  });

  afterEach(async () => {
    await clearDaemonStateForTests();
    envScope.restore();
    envScope = createEnvKeyScope([...ENV_KEYS]);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('reports at-login for a service installed with the login trigger', async () => {
    writeInstalledUnit('at-login');

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service.autostart).toBe('at-login');
  });

  it('reports on-demand for a service installed without a login trigger', async () => {
    writeInstalledUnit('on-demand');

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service).toEqual({
      installed: true,
      running: false,
      targetMode: 'default-following',
      autostart: 'on-demand',
    });
  });

  it('reports null, never at-login, for a definition that declares no mode', async () => {
    writeInstalledUnit(null);

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service.installed).toBe(true);
    expect(snapshot.service.autostart).toBeNull();
  });

  it('reports null when no service definition is installed', async () => {
    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service).toEqual({ installed: false, running: false, targetMode: null, autostart: null });
  });

  /**
   * A file that is not a readable Happier definition proves nothing, so neither `installed` nor
   * `autostart` may be taken from it — even if it happens to contain the declaration.
   */
  it('reports null when the file at the installed path is not a readable service definition', async () => {
    const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
    mkdirSync(dirname(snapshot.installedPath), { recursive: true });
    writeFileSync(snapshot.installedPath, 'Environment=HAPPIER_DAEMON_SERVICE_AUTOSTART=at-login\n');

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const result = await readDaemonStatusSnapshot();

    expect(result.service).toEqual({ installed: false, running: false, targetMode: null, autostart: null });
  });
});
