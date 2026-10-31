import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSetupCliScope, installService, markInstallDesktopManaged, previewServiceInstall, readPinnedDaemonServices, readPinnedServiceInventory, registerRelayProfile, setDaemonServiceAutostart } from './localDaemonCli.js';

describe('previewServiceInstall', () => {
  /**
   * The dry-run decides takeover and ownership conflicts for the relay it is scoped to. Setup runs
   * it before `server set`, so it must be scoped to the relay the app selected through the CLI's
   * own env server selection — never the relay the CLI happens to be configured for (R4).
   */
  it.skipIf(process.platform === 'win32')('runs the dry-run with the CLI scoped to the target relay', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-preview-target-relay-'));
    const cliPath = join(rootDir, 'happier');
    try {
      writeFileSync(
        cliPath,
        [
          '#!/bin/sh',
          'printf \'{"ok":true,"plan":{},"takeover":"%s|%s|%s|%s|%s|%s|%s"}\\n\' "$HAPPIER_SERVER_URL" "$HAPPIER_WEBAPP_URL" "$HAPPIER_LOCAL_SERVER_URL" "$HAPPIER_PUBLIC_SERVER_URL" "$HAPPIER_PUBLIC_RELEASE_CHANNEL" "$HAPPIER_RELEASE_RING" "$HAPPIER_RELEASE_CHANNEL"',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(cliPath, 0o755);

      const scope = createSetupCliScope({
        cli: { command: cliPath, provenance: 'managed', version: '0.2.13' },
        target: { serverUrl: 'https://relay-a.example.test', webappUrl: 'https://app-a.example.test', localServerUrl: null },
        processEnv: { ...process.env, HAPPIER_HOME_DIR: rootDir, HAPPIER_PUBLIC_SERVER_URL: 'https://inherited.example.test', HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:9', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'publicdev', HAPPIER_RELEASE_RING: 'preview', HAPPIER_RELEASE_CHANNEL: 'publicdev' },
      });
      const preview = await previewServiceInstall('stable', scope.target);

      expect(preview.takeover).toBe('https://relay-a.example.test|https://app-a.example.test|||stable||');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('createSetupCliScope', () => {
  const cli = { command: '/managed/happier', provenance: 'managed' as const, version: '0.2.13' };
  const target = { serverUrl: 'https://relay-b.example.test', webappUrl: 'https://app-b.example.test', localServerUrl: null };
  // A stack launch exports a service target of its own.
  // An inherited marker could otherwise stamp a service the app never meant to manage.
  const inherited = {
    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'publicdev', HAPPIER_RELEASE_RING: 'preview', HAPPIER_RELEASE_CHANNEL: 'publicdev',
    PATH: '/bin', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'stack', HAPPIER_ACTIVE_SERVER_ID: 'stack', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop', HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.happier.app',
    HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://inherited.example.test', HAPPIER_DAEMON_SERVICE_WEBAPP_URL: 'https://inherited-app.example.test', HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL: 'https://inherited-public.example.test', HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
    HAPPIER_DAEMON_SERVICE_NODE_PATH: '/other/node', HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '/other/entry', HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32', HAPPIER_DAEMON_SERVICE_UID: '999', HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/other', HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/other/.happier', HAPPIER_DAEMON_SERVICE_MODE: 'system', HAPPIER_DAEMON_SERVICE_SYSTEM_USER: 'other',
  };

  it('addresses this home\'s persisted selection and its default-following service unless told otherwise', () => {
    const scope = createSetupCliScope({ cli, target, processEnv: inherited });

    expect(scope.selected.processEnv).toEqual({ PATH: '/bin' });
    expect(scope.target.processEnv).toEqual({ PATH: '/bin', HAPPIER_SERVER_URL: target.serverUrl, HAPPIER_WEBAPP_URL: target.webappUrl });
  });

  it('a pinned run addresses the target relay and its own pinned service for every command, selecting nothing', () => {
    const scope = createSetupCliScope({ cli, target, processEnv: inherited, serviceTargetMode: 'pinned' });

    const expected = { PATH: '/bin', HAPPIER_SERVER_URL: target.serverUrl, HAPPIER_WEBAPP_URL: target.webappUrl, HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned' };
    expect(scope.target.processEnv).toEqual(expected);
    expect(scope.selected.processEnv).toEqual(expected);
  });
});

describe.skipIf(process.platform === 'win32')('kept CLI inventory adopts the effective home ring', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('retains stable desktop pins for a preview app in both inventory and status reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hsetup-kept-ring-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const command = join(root, 'happier');
      writeFileSync(join(home, 'cli-choice.json'), JSON.stringify({ mode: 'own', command }));
      writeFileSync(join(home, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'stable' }));
      const relayUrl = 'https://relay-b.example.test';
      const entry = { targetMode: 'pinned', releaseChannel: 'stable', serverId: 'relay-b', activeServerId: 'relay-b', relayUrl, happierHomeDir: home, managedBy: 'desktop' };
      // The external CLI process is the boundary; ring resolution and both inventory readers stay real.
      writeFileSync(command, `#!${process.execPath}\nconst listing = process.argv.includes('list');\nconsole.log(JSON.stringify(listing ? ${JSON.stringify({ entries: [entry], capabilities: { pinnedServiceCoexistence: true } })} : { server: { activeServerId: 'relay-b', serverUrl: '${relayUrl}', publicServerUrl: '${relayUrl}', localServerUrl: null, webappUrl: '${relayUrl}', comparableKey: 'relay-b.example.test' }, daemon: { running: false, pid: null, httpPort: null }, service: { installed: true, running: false, targetMode: 'pinned' }, auth: { authenticated: false, machineRegistered: false, machineId: null, needsAuth: true, accountId: null } }));\n`);
      chmodSync(command, 0o755);
      vi.stubEnv('HAPPIER_HOME_DIR', home);
      const cli = { command, provenance: 'override' as const, version: '0.2.13', processEnv: { ...process.env, HAPPIER_HOME_DIR: home } };
      expect(await readPinnedServiceInventory('preview', cli)).toEqual({ listed: true, coexistence: true, relayUrls: [relayUrl] });
      expect(await readPinnedDaemonServices('preview', cli)).toMatchObject({ listed: true, complete: true, items: [{ service: { relayUrl, managedBy: 'desktop' }, status: { serviceInstalled: true }, error: null }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('markInstallDesktopManaged', () => {
  const cli = { command: '/managed/happier', provenance: 'managed' as const, version: '0.2.13', processEnv: { PATH: '/bin' } };

  it('stamps the install as the desktop\'s (the lifecycle marker, nothing else)', () => {
    expect(markInstallDesktopManaged(cli).processEnv).toEqual({ PATH: '/bin', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' });
  });
});

/**
 * R16 — every `daemon service install` the desktop performs (setup's install, its preview, the
 * login-start setting; default-following or pinned) names the desktop app, so macOS Login Items
 * attributes the service to Happier. A terminal install never passes it.
 */
describe.skipIf(process.platform === 'win32')('desktop service installs name the desktop app', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function recordingCli() {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-install-bundle-id-'));
    const cliPath = join(rootDir, 'happier');
    const logPath = join(rootDir, 'log');
    writeFileSync(cliPath, ['#!/bin/sh', `echo "$1 $2 $3 bundle=$HAPPIER_DAEMON_SERVICE_BUNDLE_ID" >> '${logPath}'`, 'printf \'{"ok":true,"plan":{}}\\n\'', ''].join('\n'), 'utf8');
    chmodSync(cliPath, 0o755);
    return {
      cli: { command: cliPath, provenance: 'managed' as const, version: '0.2.13', processEnv: { PATH: process.env.PATH ?? '/bin' } },
      lines: () => readFileSync(logPath, 'utf8').trim().split('\n'),
      cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
    };
  }

  it('passes the launching app\'s bundle id to install, its preview and the login-start change', async () => {
    vi.stubEnv('HAPPIER_DESKTOP_BUNDLE_ID', 'dev.happier.app');
    const recording = recordingCli();
    try {
      await installService('stable', { replaceExisting: false, takeover: false }, recording.cli);
      await previewServiceInstall('stable', recording.cli);
      await setDaemonServiceAutostart('stable', 'on-demand', recording.cli);
      expect(recording.lines()).toEqual([
        'daemon service install bundle=dev.happier.app',
        'daemon service install bundle=dev.happier.app',
        'daemon service install bundle=dev.happier.app',
      ]);
    } finally {
      recording.cleanup();
    }
  });

  it('names no app when no desktop launched the executor, or it sent a malformed id', async () => {
    const recording = recordingCli();
    try {
      vi.stubEnv('HAPPIER_DESKTOP_BUNDLE_ID', '');
      await installService('stable', { replaceExisting: false, takeover: false }, recording.cli);
      vi.stubEnv('HAPPIER_DESKTOP_BUNDLE_ID', 'not a bundle id');
      await installService('stable', { replaceExisting: false, takeover: false }, recording.cli);
      expect(recording.lines()).toEqual(['daemon service install bundle=', 'daemon service install bundle=']);
    } finally {
      recording.cleanup();
    }
  });
});

describe('registerRelayProfile', () => {
  /** A fake CLI boundary: it logs every invocation and answers `server list`/`server add` in JSON. */
  function fakeCli(profiles: readonly Readonly<{ id: string; serverUrl: string; comparableKey: string }>[]) {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-register-profile-'));
    const cliPath = join(rootDir, 'happier');
    const logPath = join(rootDir, 'log');
    writeFileSync(cliPath, [
      '#!/bin/sh',
      `echo "$*" >> '${logPath}'`,
      'if [ "$1 $2" = "server list" ]; then',
      `  printf '%s\\n' '${JSON.stringify({ ok: true, kind: 'server_list', data: { activeServerId: 'cloud', profiles } })}'`,
      'else',
      `  printf '%s\\n' '${JSON.stringify({ ok: true, kind: 'server_add', data: { created: { id: 'relay-b-example-test', comparableKey: 'relay-b.example.test' } } })}'`,
      'fi',
      '',
    ].join('\n'), 'utf8');
    chmodSync(cliPath, 0o755);
    return {
      cli: { command: cliPath, provenance: 'managed' as const, version: '0.2.13' },
      invocations: () => readFileSync(logPath, 'utf8').trim().split('\n'),
      cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
    };
  }
  const target = { serverUrl: 'https://relay-b.example.test', webappUrl: 'https://app-b.example.test', localServerUrl: null };

  it.skipIf(process.platform === 'win32')('reuses the saved profile that already names the relay, adding nothing', async () => {
    const fake = fakeCli([{ id: 'company', serverUrl: 'https://relay-b.example.test', comparableKey: 'relay-b.example.test' }]);
    try {
      await expect(registerRelayProfile('stable', target, fake.cli)).resolves.toEqual({ id: 'company' });
      expect(fake.invocations()).toEqual(['server list --json']);
    } finally {
      fake.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('saves a profile for a relay the CLI does not know yet, without selecting it', async () => {
    const fake = fakeCli([{ id: 'cloud', serverUrl: 'https://api.happier.dev', comparableKey: 'api.happier.dev' }]);
    try {
      await expect(registerRelayProfile('stable', target, fake.cli)).resolves.toEqual({ id: 'relay-b-example-test' });
      expect(fake.invocations()[1]).toBe('server add --name relay-b.example.test --server-url https://relay-b.example.test --webapp-url https://app-b.example.test --no-use --json');
    } finally {
      fake.cleanup();
    }
  });
});
