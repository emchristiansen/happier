import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';

import { spawnSleepyDetachedProcess, spawnStoppableHttpDaemon } from './testkit/fakeDaemonLifecycle.testkit';

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
// Service-definition reads are the filesystem boundary; status selection and parsing stay real.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: readFileSyncMock,
}));

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  // An inherited dev-stack lifecycle scope would move the reaped/read state to the stack's directory.
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
]);

describe('multiDaemon release ring scoping', () => {
  let homeDir = '';

  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(fs.readFileSync);
    envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined, HAPPIER_DAEMON_SERVICE_MANAGED_BY: undefined });
  });

  afterEach(() => {
    envScope.restore();
    if (homeDir && homeDir.startsWith(tmpdir())) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    vi.resetModules();
  });

  it('prefers the canonical daemon state file and still reports a legacy ring-scoped daemon state path when only that legacy file exists', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-ring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    // Seed a minimal settings file with a cloud server profile so the list is deterministic.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: 12345,
          httpPort: 7777,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.0',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
  });

  it('falls back to a valid legacy ring-scoped daemon state when the canonical file is unreadable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'daemon.state.json'), '{not-json', 'utf-8');
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7779,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.2',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('skips a stale canonical daemon state and uses a later live legacy ring-scoped state', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-stale-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const exited = spawnSleepyDetachedProcess();
    await exited.kill();
    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: exited.pid,
          httpPort: 7780,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.3',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sleepy = spawnSleepyDetachedProcess();
    try {
      writeFileSync(
        join(serverDir, 'daemon.dev.state.json'),
        JSON.stringify(
          {
            pid: sleepy.pid,
            httpPort: 7781,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.4',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

      const entries = await listDaemonStatusesForAllKnownServers();
      const cloud = entries.find((entry) => entry.serverId === 'cloud');
      expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
      expect(cloud?.daemon.pid).toBe(sleepy.pid);
      expect(cloud?.daemon.running).toBe(true);
      expect(cloud?.daemon.staleStateFile).toBe(false);
    } finally {
      await sleepy.kill();
    }
  });

  it('reaps a live orphan in the starting daemon lifecycle scope while daemons of other relays keep running', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-orphan-reap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
            company: {
              id: 'company',
              name: 'Company',
              serverUrl: 'https://company.example.test',
              webappUrl: 'https://company.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const activeServerDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(activeServerDir, { recursive: true });
    writeFileSync(
      join(activeServerDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7790,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.5',
          controlToken: 'active-token',
        },
        null,
        2,
      ),
      'utf-8',
    );

    // A pre-canonical CLI published ring-scoped state (and held a ring-scoped lock) in the SAME
    // lifecycle directory, so the canonical lock cannot keep it from running beside the new daemon.
    const orphanPort = await reserveEphemeralPort();
    const orphan = spawnStoppableHttpDaemon(orphanPort);
    // The daemon another relay's profile runs on this machine is not an orphan of this one.
    const otherRelayPort = await reserveEphemeralPort();
    const otherRelayDaemon = spawnStoppableHttpDaemon(otherRelayPort);
    try {
      expect(await waitForHttpReady(orphanPort)).toBe(true);
      expect(await waitForHttpReady(otherRelayPort)).toBe(true);
      const orphanStatePath = join(activeServerDir, 'daemon.dev.state.json');
      writeFileSync(
        orphanStatePath,
        JSON.stringify(
          {
            pid: orphan.pid,
            httpPort: orphanPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.4',
            controlToken: 'orphan-token',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const otherRelayServerDir = join(homeDir, 'servers', 'company');
      mkdirSync(otherRelayServerDir, { recursive: true });
      const otherRelayState = JSON.stringify(
        {
          pid: otherRelayDaemon.pid,
          httpPort: otherRelayPort,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.5',
          controlToken: 'company-token',
        },
        null,
        2,
      );
      const otherRelayCanonicalStatePath = join(otherRelayServerDir, 'daemon.state.json');
      const otherRelayLegacyStatePath = join(otherRelayServerDir, 'daemon.dev.state.json');
      writeFileSync(otherRelayCanonicalStatePath, otherRelayState, 'utf-8');
      writeFileSync(otherRelayLegacyStatePath, otherRelayState, 'utf-8');

      const staleServerDir = join(homeDir, 'servers', 'stale');
      const staleStatePath = join(staleServerDir, 'daemon.state.json');
      const exited = spawnSleepyDetachedProcess();
      await exited.kill();
      const staleStateRaw = JSON.stringify({
        pid: exited.pid,
        httpPort: 7791,
        startedAt: Date.now(),
        startedWithCliVersion: '0.1.2',
      }) + '\n';
      mkdirSync(staleServerDir, { recursive: true });
      writeFileSync(staleStatePath, staleStateRaw, 'utf-8');

      vi.resetModules();
      const { reapCurrentLifecycleDaemonOrphansBeforeStart } = await import('./multiDaemon');

      const result = await reapCurrentLifecycleDaemonOrphansBeforeStart({ preservePids: [process.pid] });

      expect(result.stoppedPids).toEqual([orphan.pid]);
      expect(result.failedPids).toEqual([]);
      expect(result.preservedPids).toContain(process.pid);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      expect(() => process.kill(orphan.pid, 0)).toThrow();
      expect(existsSync(orphanStatePath)).toBe(true);

      expect(() => process.kill(otherRelayDaemon.pid, 0)).not.toThrow();
      expect(existsSync(otherRelayCanonicalStatePath)).toBe(true);
      expect(existsSync(otherRelayLegacyStatePath)).toBe(true);
      expect(readFileSync(staleStatePath, 'utf-8')).toBe(staleStateRaw);
    } finally {
      await orphan.kill();
      await otherRelayDaemon.kill();
    }
  });

  it('does not stop a live same-scope orphan when authenticated control is unavailable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-tokenless-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
            company: {
              id: 'company',
              name: 'Company',
              serverUrl: 'https://company.example.test',
              webappUrl: 'https://company.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const orphanPort = await reserveEphemeralPort();
    const orphan = spawnStoppableHttpDaemon(orphanPort);
    try {
      const orphanServerDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(orphanServerDir, { recursive: true });
      const orphanStatePath = join(orphanServerDir, 'daemon.dev.state.json');
      writeFileSync(
        orphanStatePath,
        JSON.stringify(
          {
            pid: orphan.pid,
            httpPort: orphanPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.6',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { reapCurrentLifecycleDaemonOrphansBeforeStart } = await import('./multiDaemon');

      const result = await reapCurrentLifecycleDaemonOrphansBeforeStart();

      expect(result.stoppedPids).not.toContain(orphan.pid);
      expect(result.failedPids).toContain(orphan.pid);
      expect(existsSync(orphanStatePath)).toBe(true);
      expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    } finally {
      await orphan.kill();
    }
  });
  it('reports for each relay the background service that serves it: its pinned service, or the default one for the selected relay', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-service-per-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const happierHomeDir = join(homeDir, '.happier');
    envScope.patch({
      HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: undefined,
    });
    mkdirSync(happierHomeDir, { recursive: true });
    const profile = (id: string, url: string) => ({ id, name: id, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
    writeFileSync(join(happierHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 6,
      activeServerId: 'cloud',
      servers: {
        cloud: profile('cloud', 'https://api.happier.dev'),
        personal: profile('personal', 'https://personal.example.test'),
        company: profile('company', 'https://company.example.test'),
      },
    }), 'utf-8');

    const { planDaemonServiceInstall } = await import('./service/plan');
    const writeServiceDefinition = (params: Readonly<{ targetMode: 'pinned' | 'default-following'; serverId: string; serverUrl: string }>) => {
      const plan = planDaemonServiceInstall({
        platform: 'linux',
        channel: 'stable',
        targetMode: params.targetMode,
        instanceId: params.serverId,
        activeServerId: params.serverId,
        userHomeDir: homeDir,
        happierHomeDir,
        serverUrl: params.serverUrl,
        webappUrl: params.serverUrl,
        publicServerUrl: params.serverUrl,
        nodePath: '/usr/local/bin/happier',
        entryPath: '',
      });
      const file = plan.files[0]!;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf-8');
      return file.path;
    };
    const personalServicePath = writeServiceDefinition({ targetMode: 'pinned', serverId: 'personal', serverUrl: 'https://personal.example.test' });
    const defaultServicePath = writeServiceDefinition({ targetMode: 'default-following', serverId: 'default', serverUrl: 'https://api.happier.dev' });

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');
    const entries = await listDaemonStatusesForAllKnownServers();
    const byId = new Map(entries.map((entry) => [entry.serverId, entry]));

    expect(byId.get('personal')?.service).toMatchObject({ installed: true, installedPath: personalServicePath });
    expect(byId.get('cloud')?.service).toMatchObject({ installed: true, installedPath: defaultServicePath });
    expect(byId.get('company')?.service.installed).toBe(false);

    const cloudPinnedPath = writeServiceDefinition({ targetMode: 'pinned', serverId: 'cloud', serverUrl: 'https://api.happier.dev' });
    const withPinnedWinner = await listDaemonStatusesForAllKnownServers();
    expect(withPinnedWinner.find((entry) => entry.serverId === 'cloud')?.service)
      .toMatchObject({ installed: true, installedPath: cloudPinnedPath });
  });

  it.each(['EACCES', 'EIO'])('preserves %s from service-definition reads instead of reporting not installed', async (code) => {
    homeDir = join(tmpdir(), `happier-multi-daemon-read-error-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: undefined,
    });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
      activeServerId: 'cloud',
      servers: { cloud: { id: 'cloud', name: 'Cloud', serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev' } },
    }), 'utf-8');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const cause = Object.assign(new Error('cannot read service definition'), { code });
    readFileSyncMock.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('.service')) throw cause;
      return fs.readFileSync(...args);
    });
    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');
    await expect(listDaemonStatusesForAllKnownServers())
      .rejects.toMatchObject({ code: 'service_inventory_unavailable', cause });
  });
});
