import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  systemdResourceGovernorExecFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './buildCgroupSelfMigratingHappyCliLaunchSpec';
import type { SessionLaunchId } from './sessionLaunchId';

const LAUNCH_ID = '5f0e9d8c-7b6a-4954-8372-615049382716' as SessionLaunchId;

describe('buildCgroupSelfMigratingHappyCliLaunchSpec', () => {
  let sandboxDir: string | null = null;

  afterEach(async () => {
    if (!sandboxDir) return;
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  });

  afterEach(() => {
    mocks.systemdResourceGovernorExecFile.mockReset();
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it.skipIf(process.platform === 'win32')('preserves the selected environment and argv while migrating outside the daemon app.slice', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '111');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    const home = join(sandboxDir, 'home');
    await mkdir(home);
    await writeFile(join(home, '.profile'), 'export PATH=/login-profile-path\nexport HERMES_ROLE=login-profile-role\n');
    const profilePath = '/selected-profile/bin:/usr/bin:/bin';
    const cgroupRootDir = join(sandboxDir, 'cgroup');
    const runnerArgs = ['space and \'quote', '${HOME}', '$(must-not-execute)', '--flag=value'];

    const plan = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      launchId: LAUNCH_ID,
      launchSpec: {
        runtime: 'node',
        filePath: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv.slice(1), PATH: process.env.PATH, HERMES_HOME: process.env.HERMES_HOME, HERMES_ROLE: process.env.HERMES_ROLE }))', '--', ...runnerArgs],
      },
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
      environment: { HOME: home, PATH: profilePath },
      systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
    });
    const result = plan.launchSpec;

    expect(result?.filePath).toBe('/bin/sh');
    expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
      join(cgroupRootDir, 'user.slice/user-501.slice/user@501.service'),
    );
    expect(result?.args.join(' ')).toContain('happier-session-$$.scope');

    const shellScript = result?.args[1] ?? '';
    expect(shellScript).toContain('exec "$@"');
    expect(shellScript).toContain('|| true');

    if (!result) throw new Error('expected fallback launch');
    const { stdout } = await promisify(execFile)(result.filePath, result.args, {
      env: { HOME: home, PATH: profilePath, HERMES_HOME: '/selected/hermes', HERMES_ROLE: 'operator', ...result.env },
    });
    const observed = JSON.parse(stdout);
    expect(observed).toEqual({
      pid: expect.any(Number), argv: runnerArgs,
      PATH: profilePath, HERMES_HOME: '/selected/hermes', HERMES_ROLE: 'operator',
    });
    expect(await readFile(join(
      result.env!.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR,
      `happier-session-${observed.pid}.scope`, 'cgroup.procs',
    ), 'utf8')).toBe(`${observed.pid}\n`);
  });

  it('wraps the admitted immutable runner decision without recomputing the child entrypoint', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-immutable-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '222');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    const immutableEntrypoint = '/runtime/.runner-snapshots/0123456789abcdef/index.mjs';

    const plan = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      launchId: LAUNCH_ID,
      args: ['codex', '--happy-terminal-mode', 'plain'],
      daemonPid: 222,
      procfsRootDir,
      systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
      launchOptions: {
        runtimeDecision: {
          runtime: 'node',
          argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
          env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
        },
      },
    });
    const result = plan.launchSpec;

    expect(result?.args).toEqual(expect.arrayContaining([
      immutableEntrypoint,
      'codex',
      '--happy-terminal-mode',
      'plain',
    ]));
    expect(result?.env).toMatchObject({
      HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef',
    });
  });

  it('uses the provisioned lower-weight jobs slice instead of the daemon control-plane slice', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=60582424576\nMemoryLow=4294967296\n',
      stderr: '',
    });

    try {
      const plan = await buildCgroupSelfMigratingHappyCliLaunchSpec({
        launchId: LAUNCH_ID,
        args: ['codex', '--happy-starting-mode', 'remote'],
        daemonPid: 333,
        procfsRootDir: '/proc-that-is-not-used-when-systemd-is-ready',
        environment: {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        },
        systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
      });
      const result = plan.launchSpec;

      expect(result?.filePath).toBe('systemd-run');
      expect(result?.args).toEqual(expect.arrayContaining([
        '--user',
        '--scope',
        '--slice=happier-jobs.slice',
        `--unit=happier-launch-${LAUNCH_ID}.scope`,
        '--nice=10',
        '--expand-environment=no',
        '--',
        'codex',
      ]));
      expect(plan.placement).toEqual({
        kind: 'systemd-scope',
        launchId: LAUNCH_ID,
        unitName: `happier-launch-${LAUNCH_ID}.scope`,
      });
      expect(result?.args.join(' ')).not.toMatch(/MemoryMax|MemoryHigh|MemoryLimit|OOM/u);
      expect(result?.env?.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBe('');
      expect(mocks.systemdResourceGovernorExecFile).toHaveBeenCalledWith(
        'systemctl',
        [
          '--user',
          'show',
          'happier-jobs.slice',
          '--property=LoadState',
          '--property=CPUWeight',
          '--property=IOWeight',
          '--property=MemoryHigh',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
          }),
        }),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('keeps the legacy self-migrating scope when the provisioned user slice is unavailable', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-launch-spec-fallback-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '444');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    mocks.systemdResourceGovernorExecFile.mockResolvedValue({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=infinity\nMemoryLow=0\n',
      stderr: '',
    });

    try {
      const plan = await buildCgroupSelfMigratingHappyCliLaunchSpec({
        launchId: LAUNCH_ID,
        args: ['codex'],
        daemonPid: 444,
        procfsRootDir,
        environment: {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        },
        systemdUserResourceGovernorExecFile: mocks.systemdResourceGovernorExecFile,
      });
      const result = plan.launchSpec;

      expect(result?.filePath).toBe('/bin/sh');
      expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
        '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service',
      );
      expect(plan.placement).toEqual({
        kind: 'unscoped',
        probe: { kind: 'slice-mismatch', property: 'MemoryHigh', expected: 'positive-finite', actual: 'infinity' },
      });
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
