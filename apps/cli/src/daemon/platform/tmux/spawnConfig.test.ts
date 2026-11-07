import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduling priority is an OS boundary; keep the shared launch policy real.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

import { buildHostedRunnerSpawnConfig, buildTmuxSpawnConfig } from './spawnConfig';
import type { SessionLaunchId } from '../linux/sessionLaunchId';

const LAUNCH_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' as SessionLaunchId;

describe('tmux session resource policy', () => {
  const originalPlatform = process.platform;
  let commandDirectory: string | null = null;

  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllEnvs();
    if (commandDirectory) await rm(commandDirectory, { recursive: true, force: true });
    commandDirectory = null;
  });

  it('preserves local terminal presentation for a hosted server-backed runner', async () => {
    const config = await buildTmuxSpawnConfig({
      launchId: LAUNCH_ID,
      agent: 'codex',
      directory: '/tmp',
      extraEnv: {},
      startingMode: 'local',
    });

    expect(config.commandTokens).toEqual(expect.arrayContaining([
      'codex', '--happy-starting-mode', 'local', '--started-by', 'daemon',
    ]));
  });

  it('passes the complete prepared child environment to a Herdr-hosted runner', async () => {
    const config = await buildHostedRunnerSpawnConfig({
      launchId: LAUNCH_ID,
      host: 'herdr',
      agent: 'codex',
      directory: '/tmp',
      extraEnv: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' },
      processEnv: { PATH: '/bin', XDG_CONFIG_HOME: '/test/config', HAPPIER_ACTIVE_SERVER_ID: 'stale' },
      serverSelectionEnv: {
        activeServerId: 'current',
        canonicalServerUrl: 'https://relay.example.test',
        apiServerUrl: 'https://relay.example.test',
        webappUrl: 'https://relay.example.test',
      },
      startingMode: 'local',
    });

    expect(config.childEnv).toMatchObject({
      XDG_CONFIG_HOME: '/test/config',
      HAPPIER_ACTIVE_SERVER_ID: 'current',
      HAPPIER_CODEX_BACKEND_MODE: 'appServer',
    });
    expect(config.commandTokens).toEqual(expect.arrayContaining(['codex', '--happy-starting-mode', 'local']));
  });

  async function provisionJobsProbe() {
    commandDirectory = await mkdtemp(join(tmpdir(), 'happier-tmux-resource-policy-'));
    // The executable is the OS boundary; launch/env selection remains real.
    await writeFile(join(commandDirectory, 'systemctl'), [
      '#!/bin/sh',
      'test "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=/test/session-bus" || exit 1',
      'case "$*" in *happier-jobs.slice*) ;; *) exit 1 ;; esac',
      'printf "LoadState=loaded\\nCPUWeight=50\\nIOWeight=50\\nMemoryHigh=1073741824\\n"',
      '',
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('PATH', `${commandDirectory}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test/session-bus');
    vi.stubEnv('XDG_RUNTIME_DIR', '/test/runtime');
    vi.stubEnv('HAPPIER_DAEMON_STARTUP_SOURCE', 'background-service');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  }

  it('uses the same provisioned jobs scope and child environment as regular session launches', async () => {
    vi.mocked(getPriority).mockReturnValue(19);
    await provisionJobsProbe();
    const config = await buildTmuxSpawnConfig({
      launchId: LAUNCH_ID,
      agent: 'codex',
      directory: '/tmp',
      extraEnv: { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '1' },
      launchOptions: { runtimeDecision: {
        runtime: 'node',
        argvPrefix: ['--no-warnings', '/test/admitted-runner.mjs'],
        env: { HAPPIER_TEST_RUNNER_ENV: 'retained' },
      } },
    });

    expect(config.commandTokens[0]).toBe('systemd-run');
    expect(config.commandTokens).toEqual(expect.arrayContaining([
      '--slice=happier-jobs.slice', `--unit=happier-launch-${LAUNCH_ID}.scope`, '--nice=19',
      '--expand-environment=no', '/test/admitted-runner.mjs', 'codex',
    ]));
    expect(config.placement).toEqual({
      kind: 'systemd-scope',
      launchId: LAUNCH_ID,
      unitName: `happier-launch-${LAUNCH_ID}.scope`,
    });
    expect(config.tmuxEnv.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/test/session-bus');
    expect(config.tmuxEnv.XDG_RUNTIME_DIR).toBe('/test/runtime');
    expect(config.tmuxEnv.HAPPIER_TEST_RUNNER_ENV).toBe('retained');
    expect(config.tmuxEnv.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).not.toBe('1');
  });

  it('reports a non-Linux tmux launch as unscoped with its reason', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    const config = await buildTmuxSpawnConfig({
      launchId: LAUNCH_ID,
      agent: 'codex',
      directory: '/tmp',
      extraEnv: {},
    });

    expect(config.commandTokens[0]).not.toBe('systemd-run');
    expect(config.placement).toEqual({
      kind: 'unscoped',
      probe: { kind: 'unsupported-platform', platform: 'darwin' },
    });
  });

  it('pins daemon-owned child keys so a long-lived tmux server cannot leak stale relay state', async () => {
    const config = await buildTmuxSpawnConfig({
      launchId: LAUNCH_ID,
      agent: 'claude',
      directory: '/tmp',
      extraEnv: {},
      processEnv: {
        PATH: '/bin',
        HAPPIER_ACTIVE_SERVER_ID: 'stale-server',
        HAPPIER_SERVER_URL: 'https://stale.example.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://stale-public.example.test',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      },
      serverSelectionEnv: {
        activeServerId: 'custom',
        canonicalServerUrl: 'https://relay.example.test:27443',
        apiServerUrl: 'https://relay.example.test:27443',
        webappUrl: 'https://relay.example.test:27443',
      },
    });

    expect(config.tmuxEnv).toMatchObject({
      HAPPIER_ACTIVE_SERVER_ID: 'custom',
      HAPPIER_SERVER_URL: 'https://relay.example.test:27443',
      HAPPIER_WEBAPP_URL: 'https://relay.example.test:27443',
      HAPPIER_PUBLIC_SERVER_URL: '',
      HAPPIER_LOCAL_SERVER_URL: '',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      HAPPIER_DAEMON_STARTUP_SOURCE: '',
    });
  });
});
