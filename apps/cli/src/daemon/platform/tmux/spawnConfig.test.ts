import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionLaunchId } from '../linux/sessionLaunchId';
import { buildTmuxSpawnConfig } from './spawnConfig';

const LAUNCH_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' as SessionLaunchId;

describe('tmux session resource policy', () => {
  const originalPlatform = process.platform;
  let commandDirectory: string | null = null;

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllEnvs();
    if (commandDirectory) await rm(commandDirectory, { recursive: true, force: true });
    commandDirectory = null;
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
      '--slice=happier-jobs.slice', `--unit=happier-launch-${LAUNCH_ID}.scope`, '--nice=10',
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
});
