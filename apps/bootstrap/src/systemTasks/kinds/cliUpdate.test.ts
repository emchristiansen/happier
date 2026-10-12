import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const { runCommandCaptureMock } = vi.hoisted(() => ({
  runCommandCaptureMock: vi.fn(),
}));

// Only the OS process boundary is replaced; CLI parsing, service observation and the shared
// restart policy stay real. The transaction is exercised in setupFloor.integration and cli-common.
vi.mock('../taskRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../taskRuntime.js')>();
  return {
    ...actual,
    runCommandCapture: runCommandCaptureMock,
  };
});

import { createCliUpdateHandler } from './cliUpdate.js';
import { planLocalHappierCliUpdateRestart } from '../localDaemonCli.js';

const CURRENT_CLI = { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' as const, version: '0.2.13' };

function statusJson(params: Readonly<{ running: boolean; serviceManaged: boolean; version?: string }>) {
  return {
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      localServerUrl: null,
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      comparableKey: 'api.happier.dev',
    },
    daemon: {
      running: params.running,
      pid: params.running ? 42 : null,
      httpPort: params.running ? 7777 : null,
      serviceManaged: params.serviceManaged,
      ...(params.version ? { startedWithCliVersion: params.version } : {}),
    },
    service: { installed: true, running: params.running },
    auth: { authenticated: true, machineRegistered: true, machineId: 'm1', needsAuth: false, accountId: 'acct' },
  };
}

type CliCall = Readonly<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }>;

/**
 * Answers the CLI by what it was asked: each service's status reads in order (the default-following
 * one, or a pinned one by its instance), `ok` for every lifecycle command, and the service
 * inventory — none unless a test lists pinned services.
 */
function answerCli(params: Readonly<{
  defaultStatuses: readonly unknown[];
  pinned?: Readonly<Record<string, Readonly<{ relayUrl: string; statuses: readonly unknown[]; unreadable?: boolean; managedBy?: 'desktop' | null }>>>;
}>): void {
  const reads = new Map<string, number>();
  runCommandCaptureMock.mockImplementation(async (call: CliCall) => {
    const command = call.args.join(' ');
    if (command === 'daemon service list --json') {
      const inventory = {
        entries: Object.entries(params.pinned ?? {}).map(([instance, service]) => ({
          serverId: instance,
          activeServerId: instance,
          relayUrl: service.relayUrl,
          targetMode: 'pinned',
          releaseChannel: 'stable',
          happierHomeDir: process.env.HAPPIER_HOME_DIR,
          managedBy: service.managedBy ?? null,
        })),
      };
      return { status: 0, stdout: JSON.stringify(inventory), stderr: '' };
    }
    if (command !== 'daemon status --json') {
      return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    }
    const instance = call.env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? 'default';
    if (instance !== 'default' && params.pinned?.[instance]?.unreadable) {
      throw new Error('unreadable service definition');
    }
    const statuses = instance === 'default' ? params.defaultStatuses : params.pinned?.[instance]?.statuses ?? [];
    const index = reads.get(instance) ?? 0;
    reads.set(instance, index + 1);
    return { status: 0, stdout: JSON.stringify(statuses[Math.min(index, statuses.length - 1)]), stderr: '' };
  });
}

function commandLog(): string[] {
  return runCommandCaptureMock.mock.calls
    .map(([call]) => `${(call as CliCall).args.join(' ')}@${(call as CliCall).env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? 'default'}`)
    .filter((entry) => !entry.startsWith('daemon service list'));
}

async function run(params: Readonly<{ channel: 'stable' | 'preview' }>) {
  const events: unknown[] = [];
  const restart = await planLocalHappierCliUpdateRestart({ current: CURRENT_CLI, releaseRing: params.channel, emit: (event) => { events.push(event); } });
  await restart?.({ expectedVersion: '0.2.14', phase: 'activated' });
  return { result: { restarted: restart !== null }, events };
}

describe('CLI update service restart owner', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    vi.clearAllMocks();
    runCommandCaptureMock.mockReset();
    process.env = { ...originalEnv };
  });

  it('restarts a running service daemon through the service\'s own relay selection and proves the new version', async () => {
    // A stack-pinned launch: the restart and its proof must not follow the pinned profile.
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack-pinned';
    answerCli({ defaultStatuses: [
      statusJson({ running: true, serviceManaged: true, version: '0.2.13' }),
      statusJson({ running: true, serviceManaged: true, version: '0.2.14' }),
    ] });

    const { result } = await run({ channel: 'preview' });

    expect(commandLog()).toEqual([
      'daemon status --json@default',
      'daemon service restart --json@default',
      'daemon status --json@default',
    ]);
    for (const [call] of runCommandCaptureMock.mock.calls) {
      expect(call.command).toBe(CURRENT_CLI.command);
      expect(call.env.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
    }
    expect(result).toEqual({ restarted: true });
  });

  it('does not start a daemon that was not running, nor restart a manual one', async () => {
    answerCli({ defaultStatuses: [statusJson({ running: false, serviceManaged: false })] });
    expect((await run({ channel: 'stable' })).result).toEqual({ restarted: false });

    answerCli({ defaultStatuses: [statusJson({ running: true, serviceManaged: false, version: '0.2.13' })] });
    expect((await run({ channel: 'stable' })).result).toMatchObject({ restarted: false });
    expect(runCommandCaptureMock.mock.calls.some((call) => call[0].args.includes('restart'))).toBe(false);
  });

  it('fails the restart proof when the restarted daemon still runs the previous version', async () => {
    answerCli({ defaultStatuses: [statusJson({ running: true, serviceManaged: true, version: '0.2.13' })] });

    await expect(run({ channel: 'stable' })).rejects.toThrow(/runs 0\.2\.13 instead of 0\.2\.14/);
  });

  /**
   * One daemon per relay: a relay this computer also serves runs its own pinned service on the same
   * managed CLI. The update restarts every running service daemon of this home onto the new CLI and
   * proves each one — otherwise that relay's daemon keeps running the version the update replaced.
   */
  it('restarts each running pinned service daemon of this home too, and proves each on the new version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-pinned-'));
    process.env.HAPPIER_HOME_DIR = home;
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    answerCli({
      defaultStatuses: [
        statusJson({ running: true, serviceManaged: true, version: '0.2.13' }),
        statusJson({ running: true, serviceManaged: true, version: '0.2.14' }),
      ],
      pinned: {
        'relay-b': { relayUrl: 'https://relay-b.example.test', statuses: [
          statusJson({ running: true, serviceManaged: true, version: '0.2.13' }),
          statusJson({ running: true, serviceManaged: true, version: '0.2.14' }),
        ] },
        // Installed but stopped: an update does not start a daemon that was not running.
        'relay-c': { relayUrl: 'https://relay-c.example.test', statuses: [statusJson({ running: false, serviceManaged: false })] },
      },
    });

    const { result } = await run({ channel: 'stable' });

    expect(commandLog()).toEqual(expect.arrayContaining([
      'daemon service restart --json@default',
      'daemon service restart --json@relay-b',
    ]));
    expect(commandLog()).not.toContain('daemon service restart --json@relay-c');
    const restartB = runCommandCaptureMock.mock.calls
      .map(([call]) => call as CliCall)
      .find((call) => call.args.join(' ') === 'daemon service restart --json' && call.env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID === 'relay-b');
    expect(restartB?.env).toMatchObject({ HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_SERVER_URL: 'https://relay-b.example.test' });
    expect(result).toEqual({ restarted: true });
  });

  it('fails the proof when a pinned service daemon did not come back on the new version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-pinned-stale-'));
    process.env.HAPPIER_HOME_DIR = home;
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    answerCli({
      defaultStatuses: [statusJson({ running: false, serviceManaged: false })],
      pinned: { 'relay-b': { relayUrl: 'https://relay-b.example.test', managedBy: 'desktop', statuses: [statusJson({ running: true, serviceManaged: true, version: '0.2.13' })] } },
    });

    await expect(run({ channel: 'stable' })).rejects.toThrow(/runs 0\.2\.13 instead of 0\.2\.14/);
  });

  it('keeps the update when only a pinned service the user installed does not come back, and names it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-user-owned-'));
    process.env.HAPPIER_HOME_DIR = home;
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    answerCli({
      defaultStatuses: [
        statusJson({ running: true, serviceManaged: true, version: '0.2.13' }),
        statusJson({ running: true, serviceManaged: true, version: '0.2.14' }),
      ],
      // No marker: the user installed this service. It is restarted, but it does not decide the update.
      pinned: { 'relay-b': { relayUrl: 'https://relay-b.example.test', statuses: [statusJson({ running: true, serviceManaged: true, version: '0.2.13' })] } },
    });

    const { result, events } = await run({ channel: 'stable' });

    expect(result).toEqual({ restarted: true });
    expect(commandLog()).toContain('daemon service restart --json@relay-b');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'progress',
      stepId: 'cli.update.restartServices',
      // The shared wording names that exact pinned service's restart, not `service restart` (the default one).
      message: expect.stringMatching(/\(relay-b\) did not come back on 0\.2\.14 \(the background service runs 0\.2\.13 instead of 0\.2\.14\); the update was kept\. Start it with: \S+ --server relay-b service restart --instance=relay-b$/),
    }));
  });

  it('restarts every relay\'s service daemon even when one does not come back, then names the one that failed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-attempt-all-'));
    process.env.HAPPIER_HOME_DIR = home;
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    answerCli({
      // The default-following daemon does not come back on the new version…
      defaultStatuses: [statusJson({ running: true, serviceManaged: true, version: '0.2.13' })],
      // …which must not leave relay B's daemon stopped on the old one.
      pinned: { 'relay-b': { relayUrl: 'https://relay-b.example.test', statuses: [
        statusJson({ running: true, serviceManaged: true, version: '0.2.13' }),
        statusJson({ running: true, serviceManaged: true, version: '0.2.14' }),
      ] } },
    });

    await expect(run({ channel: 'stable' })).rejects.toThrow(/runs 0\.2\.13 instead of 0\.2\.14/);
    expect(commandLog()).toContain('daemon service restart --json@relay-b');
  });

  /** M6 — an unreadable pinned service is not "no daemon to restart": the run says so. */
  it('names a relay service it could not read instead of treating it as having no daemon to restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-pinned-unreadable-'));
    process.env.HAPPIER_HOME_DIR = home;
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    answerCli({
      defaultStatuses: [statusJson({ running: false, serviceManaged: false })],
      pinned: { 'relay-b': { relayUrl: 'https://relay-b.example.test', statuses: [], unreadable: true } },
    });

    const { events } = await run({ channel: 'stable' });

    expect(JSON.stringify(events)).toContain('https://relay-b.example.test');
  });

  it('rejects an unknown channel without updating anything', async () => {
    const iterator = createCliUpdateHandler()({ channel: 'nightly' }, { signal: new AbortController().signal });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'invalid_params' });
    expect(runCommandCaptureMock).not.toHaveBeenCalled();
  });
});
