import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionLaunchId } from './sessionLaunchId';

// Scheduling priority is an OS boundary; keep the real launch policy underneath it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

import {
  buildSystemdUserCriticalScopedLaunchSpec,
  buildSystemdUserScopedLaunchSpec,
  probeSystemdUserResourceGovernor,
  shouldUseSystemdUserSessionResourceGovernor,
} from './systemdUserResourceGovernor';

const FIXED_LAUNCH_ID = '0b7c8f2e-4d1a-4c3b-9e8f-7a6b5c4d3e2f' as SessionLaunchId;

describe('systemd user resource governor', () => {
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });

  it.each([
    ['linux background service', 'linux', 'background-service', true],
    ['linux self-restart', 'linux', 'self-restart', true],
    ['linux manual daemon', 'linux', 'manual', true],
    ['non-linux self-restart', 'darwin', 'self-restart', false],
  ] as const)('selects the session governor for %s', (_label, platform, startupSource, expected) => {
    expect(shouldUseSystemdUserSessionResourceGovernor({ platform, startupSource })).toBe(expected);
  });

  it('wraps an admitted runner in the disposable jobs slice without imposing a CPU or memory cap', () => {
    const spec = buildSystemdUserScopedLaunchSpec({
      launchId: FIXED_LAUNCH_ID,
      launchSpec: {
        filePath: '/opt/happier/runtime/bin/happier-js-runtime',
        args: [
          '--no-warnings',
          '/opt/happier/.runner-snapshots/immutable/index.mjs',
          'codex',
          '--happy-starting-mode',
          'remote',
        ],
        env: { HAPPIER_TEST_ADMITTED_CLOSURE: 'immutable' },
      },
    });

    expect(spec).toEqual({
      filePath: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--slice=happier-jobs.slice',
        `--unit=happier-launch-${FIXED_LAUNCH_ID}.scope`,
        '--nice=10',
        '--expand-environment=no',
        '--',
        '/opt/happier/runtime/bin/happier-js-runtime',
        '--no-warnings',
        '/opt/happier/.runner-snapshots/immutable/index.mjs',
        'codex',
        '--happy-starting-mode',
        'remote',
      ],
      env: { HAPPIER_TEST_ADMITTED_CLOSURE: 'immutable' },
    });
    expect(spec.args.join(' ')).not.toMatch(/CPUQuota|MemoryMax|MemoryHigh|TasksMax/u);
  });

  it('preserves an inherited lower scheduling priority instead of requiring permission to raise it', () => {
    vi.mocked(getPriority).mockReturnValue(19);

    const spec = buildSystemdUserScopedLaunchSpec({
      launchId: FIXED_LAUNCH_ID,
      launchSpec: { filePath: '/opt/happier/runtime/bin/happier-js-runtime', args: ['claude'] },
    });

    expect(spec.args).toContain('--nice=19');
    expect(spec.args).not.toContain('--nice=10');
  });

  it('only enables the Linux wrapper when the provisioned jobs slice has its expected shares and finite soft memory boundary', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=60129542144\n',
      stderr: '',
    }));

    await expect(probeSystemdUserResourceGovernor({
      platform: 'linux',
      environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
      execFile,
    })).resolves.toEqual({ kind: 'ready' });

    expect(execFile).toHaveBeenCalledWith(
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
        timeout: 1_000,
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
      }),
    );
  });

  it.each([
    ['a non-Linux platform', {
      platform: 'darwin' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: '',
      expected: { kind: 'unsupported-platform', platform: 'darwin' },
    }],
    ['no user-systemd bus', {
      platform: 'linux' as const,
      environment: {},
      stdout: '',
      expected: { kind: 'no-user-bus' },
    }],
    ['an unloaded slice', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=not-found\nCPUWeight=50\nIOWeight=50\nMemoryHigh=1073741824\n',
      expected: { kind: 'slice-mismatch', property: 'LoadState', expected: 'loaded', actual: 'not-found' },
    }],
    ['an unweighted dynamic slice', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=loaded\nCPUWeight=[not set]\nIOWeight=[not set]\nMemoryHigh=infinity\n',
      expected: { kind: 'slice-mismatch', property: 'CPUWeight', expected: '50', actual: '[not set]' },
    }],
    ['the runtime disable override (CPUWeight=49)', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=loaded\nCPUWeight=49\nIOWeight=50\nMemoryHigh=1073741824\n',
      expected: { kind: 'slice-mismatch', property: 'CPUWeight', expected: '50', actual: '49' },
    }],
    ['a jobs slice without a finite soft memory boundary', {
      platform: 'linux' as const,
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=infinity\n',
      expected: { kind: 'slice-mismatch', property: 'MemoryHigh', expected: 'positive-finite', actual: 'infinity' },
    }],
  ])('names why it fails closed for %s', async (_label, fixture) => {
    const execFile = vi.fn(async () => ({ stdout: fixture.stdout, stderr: '' }));

    await expect(probeSystemdUserResourceGovernor({
      platform: fixture.platform,
      environment: fixture.environment,
      execFile,
    })).resolves.toEqual(fixture.expected);
  });

  it('separates a probe timeout from a probe error', async () => {
    const timedOut = Object.assign(new Error('Command failed: systemctl --user show happier-jobs.slice'), {
      killed: true,
      signal: 'SIGTERM',
    });
    await expect(probeSystemdUserResourceGovernor({
      platform: 'linux',
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      execFile: vi.fn(async () => { throw timedOut; }),
    })).resolves.toEqual({ kind: 'probe-timeout' });

    const failed = Object.assign(new Error('Command failed: systemctl --user show happier-jobs.slice\nFailed to connect to bus: No such file or directory'), {
      killed: false,
      code: 1,
    });
    await expect(probeSystemdUserResourceGovernor({
      platform: 'linux',
      environment: { DBUS_SESSION_BUS_ADDRESS: 'x' },
      execFile: vi.fn(async () => { throw failed; }),
    })).resolves.toEqual({
      kind: 'probe-error',
      message: 'Command failed: systemctl --user show happier-jobs.slice\nFailed to connect to bus: No such file or directory',
    });
  });

  it('keeps systemd-run from expanding the critical daemon launch either', () => {
    const spec = buildSystemdUserCriticalScopedLaunchSpec({ launchSpec: { filePath: '/daemon', args: ['daemon', 'start-sync'] } });
    expect(spec.args.indexOf('--expand-environment=no')).toBeGreaterThan(-1);
    expect(spec.args.indexOf('--expand-environment=no')).toBeLessThan(spec.args.indexOf('--'));
    expect(spec.args.some((arg) => arg.startsWith('--unit='))).toBe(false);
  });
});

describe('systemd-run argv fidelity', () => {
  let commandDirectory: string | null = null;

  afterEach(async () => {
    if (commandDirectory) await rm(commandDirectory, { recursive: true, force: true });
    commandDirectory = null;
  });

  /**
   * A stand-in for systemd-run(1) at the OS boundary. Per the systemd 260.4 man page,
   * `--expand-environment=` defaults to enabled, and with --scope systemd-run itself
   * replaces `${VAR}` and `$VAR` (and `$$` with `$`) in the command line before exec.
   * The stand-in applies that substitution unless `--expand-environment=no` precedes `--`.
   */
  async function provisionSystemdRun(): Promise<{ recordPath: string; recorderPath: string }> {
    commandDirectory = await mkdtemp(join(tmpdir(), 'happier-systemd-run-argv-'));
    const recordPath = join(commandDirectory, 'argv.json');
    const recorderPath = join(commandDirectory, 'record-argv');
    await writeFile(join(commandDirectory, 'systemd-run'), [
      `#!${process.execPath}`,
      "const { spawnSync } = require('node:child_process');",
      'const argv = process.argv.slice(2);',
      "const separator = argv.indexOf('--');",
      "if (separator < 0) { process.stderr.write('systemd-run stand-in: missing --\\n'); process.exit(2); }",
      "const expand = !argv.slice(0, separator).includes('--expand-environment=no');",
      'const substitute = (word) => word.replace(/\\$\\$|\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}|\\$([A-Za-z_][A-Za-z0-9_]*)/g,',
      "  (match, braced, bare) => (match === '$$' ? '$' : (process.env[braced ?? bare] ?? '')));",
      'const command = argv.slice(separator + 1).map((word) => (expand ? substitute(word) : word));',
      "const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });",
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n'), { mode: 0o700 });
    await writeFile(recorderPath, [
      `#!${process.execPath}`,
      "require('node:fs').writeFileSync(process.env.ARGV_RECORD_PATH, JSON.stringify(process.argv.slice(2)));",
      '',
    ].join('\n'), { mode: 0o700 });
    return { recordPath, recorderPath };
  }

  it('delivers $VAR, ${X} and $$ to the launched runner literally', async () => {
    const { recordPath, recorderPath } = await provisionSystemdRun();
    const runnerArgs = [
      'claude',
      '--resume',
      '/home/u/proj/$VAR/session.jsonl',
      '--model',
      'model-${X}-v2',
      'cost$$',
      '$HOME',
    ];
    const spec = buildSystemdUserScopedLaunchSpec({
      launchId: FIXED_LAUNCH_ID,
      launchSpec: { filePath: recorderPath, args: runnerArgs },
    });

    const launched = spawnSync(spec.filePath, spec.args, {
      env: {
        ...process.env,
        PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ''}`,
        ARGV_RECORD_PATH: recordPath,
        VAR: 'expanded-var',
        X: 'expanded-x',
        HOME: '/expanded-home',
      },
      encoding: 'utf8',
    });
    expect(launched.stderr).toBe('');
    expect(launched.status).toBe(0);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(runnerArgs);
    expect(spec.args.indexOf('--expand-environment=no')).toBeGreaterThan(-1);
    expect(spec.args.indexOf('--expand-environment=no')).toBeLessThan(spec.args.indexOf('--'));
  });
});
