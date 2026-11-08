import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const { loggerInfoMock, loggerWarnMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

// File-log sink boundary of THIS (daemon-hosting) process only; the child processes use the real logger,
// which writes under their temp HAPPIER_HOME_DIR.
vi.mock('@/ui/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
  },
}));

import { createDaemonControlApp } from '@/daemon/controlServer';
import {
  createExecutionRunConnectedServicesBridge,
  type ResolveConnectedServiceAuthForRun,
} from '@/daemon/connectedServices/runsBridge/materializeConnectedServicesForRun';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';

/**
 * The multi-process composition the in-process daemon-bridge test cannot show. This process hosts the
 * real daemon control app (real run bridge, real runtime registry, real routes and scoped token) on a
 * loopback TCP port and publishes it through a daemon state file in a temp HAPPIER_HOME_DIR. Separate
 * short-lived child processes run the real native-process commands with the DEFAULT daemon transport,
 * which finds the daemon only through that state file. A separate child stands in for the native workload,
 * which runs, and is killed, between materialize and release. The registration must be anchored to the
 * published daemon pid (this process), never to the exited command or the workload, whose pids can be
 * reused by unrelated tracked sessions. Only the provider materializer behind
 * `resolveAuthForSpawn` is a stand-in; it returns a CLAUDE_CONFIG_DIR path and no credential.
 */

const require = createRequire(import.meta.url);
const CLI_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const TSX_LOADER = join(dirname(require.resolve('tsx/package.json')), 'dist', 'esm', 'index.mjs');
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./nativeConnectedServices.ts', import.meta.url))).href;
const CONFIGURATION_URL = pathToFileURL(join(CLI_DIR, 'src', 'configuration.ts')).href;
const PERSISTENCE_URL = pathToFileURL(join(CLI_DIR, 'src', 'persistence.ts')).href;
const INVENTORY = { items: [{ serviceId: 'claude-subscription', profiles: [{ profileId: 'fixture', status: 'connected' }] }] };
const CHILD_TIMEOUT_MS = 90_000;
// Each driver marks its one result line; the materialize command's decision lines go to its log file, so
// its stdout must hold that line alone.
const RESULT_PREFIX = '@@native-cs-result@@ ';

function parseResult<T>(stdout: string): T {
  const lines = stdout.split('\n').filter((line) => line.startsWith(RESULT_PREFIX));
  expect(lines, stdout).toHaveLength(1);
  return JSON.parse(lines[0]!.slice(RESULT_PREFIX.length)) as T;
}

type Resolved = NonNullable<Awaited<ReturnType<ResolveConnectedServiceAuthForRun>>>;

function claudeHomeResolution(bindingsRaw: unknown, configDir: string): Resolved {
  return {
    env: { CLAUDE_CONFIG_DIR: configDir },
    materializationRoot: configDir,
    cleanupMaterializationRoot: null,
    cleanupOnFailure: null,
    cleanupOnExit: null,
    connectedServicesBindings: ConnectedServiceBindingsV1Schema.parse(bindingsRaw),
    runtimeAccountIdentitySelections: [],
  };
}

const PROBE_DRIVER = `
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const { configuration } = await import(${JSON.stringify(CONFIGURATION_URL)});
const { resolveDaemonStateCandidatePathsForCurrentLifecycle } = await import(${JSON.stringify(PERSISTENCE_URL)});
process.stdout.write(RESULT_PREFIX + JSON.stringify({
  happyHomeDir: configuration.happyHomeDir,
  daemonStateFile: configuration.daemonStateFile,
  candidates: resolveDaemonStateCandidatePathsForCurrentLifecycle(),
}) + '\\n');
process.exit(0);
`;

const MATERIALIZE_DRIVER = `
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const { materializeClaudeProfileForNativeProcess } = await import(${JSON.stringify(MODULE_URL)});
const [expectedConfigDir] = process.argv.slice(2);
try {
  const readiness = await materializeClaudeProfileForNativeProcess(
    { profileId: 'fixture', expectedConfigDir, cwd: process.cwd() },
    { listInventory: async () => (${JSON.stringify(INVENTORY)}) },
  );
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ pid: process.pid, readiness }) + '\\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.code ?? 'unknown') + ' ' + String(error?.message ?? error) + '\\n');
  process.exit(1);
}
`;

const RELEASE_DRIVER = `
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const { releaseClaudeProfileForNativeProcess } = await import(${JSON.stringify(MODULE_URL)});
const [materializationKey] = process.argv.slice(2);
try {
  await releaseClaudeProfileForNativeProcess({ materializationKey });
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ pid: process.pid, released: true }) + '\\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.code ?? 'unknown') + ' ' + String(error?.message ?? error) + '\\n');
  process.exit(1);
}
`;

type ChildResult = Readonly<{ pid: number; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

const liveChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe.runIf(process.platform !== 'win32')('native Claude profile commands across processes via the daemon state file', () => {
  let root = '';
  let happierHome = '';
  let driversDir = '';
  let configDir = '';
  let childEnv: NodeJS.ProcessEnv = {};
  let registry: ConnectedServiceRuntimeRegistry;
  let app: ReturnType<typeof createDaemonControlApp> | null = null;
  const resolveAuthForSpawn = vi.fn<ResolveConnectedServiceAuthForRun>(async (params) =>
    claudeHomeResolution(params.connectedServicesBindingsRaw, configDir));

  const refreshTargetsFor = (profileId: string) => registry.listRefreshTargets()
    .filter((target) => target.bindings.some((b) => b.serviceId === 'claude-subscription' && b.profileId === profileId));

  // Each command runs as its own node process (the tsx loader via --import, so the process that runs the
  // command IS the spawned pid; the tsx CLI would interpose a second process).
  async function runDriver(driverName: string, args: readonly string[], env: NodeJS.ProcessEnv = childEnv): Promise<ChildResult> {
    const child = trackChild(spawn(process.execPath, ['--no-warnings', '--import', TSX_LOADER, join(driversDir, driverName), ...args], {
      cwd: CLI_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    try {
      const { code, signal } = await waitForExit(child);
      return { pid: child.pid!, code, signal, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-native-cs-multiprocess-'));
    happierHome = join(root, 'happier-home');
    driversDir = join(root, 'drivers');
    configDir = join(root, 'claude-config');
    await mkdir(happierHome, { recursive: true });
    await mkdir(driversDir, { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(driversDir, 'probe.mts'), PROBE_DRIVER);
    await writeFile(join(driversDir, 'materialize.mts'), MATERIALIZE_DRIVER);
    await writeFile(join(driversDir, 'release.mts'), RELEASE_DRIVER);

    // A minimal, explicit child environment: nothing inherited can point a child at another daemon
    // home, server or account. The server URL only selects the per-server state directory; nothing in
    // these commands contacts it (port 9 is discard).
    childEnv = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      TMPDIR: tmpdir(),
      HAPPIER_HOME_DIR: happierHome,
      HAPPIER_SERVER_URL: 'http://127.0.0.1:9',
      HAPPIER_FEATURE_POLICY_ENV: '',
      TSX_TSCONFIG_PATH: join(CLI_DIR, 'tsconfig.json'),
    };

    const controlToken = randomBytes(24).toString('hex');
    registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn,
      runtimeRegistry: registry,
      logger: { debug: vi.fn() },
    });
    app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken,
      handleExecutionRunConnectedServiceMaterialize: async (input: Parameters<typeof bridge.materialize>[0]) =>
        await bridge.materialize({ ...input, agentId: 'claude' }),
      handleExecutionRunConnectedServiceRelease: async (input: Parameters<typeof bridge.release>[0]) =>
        await bridge.release(input),
    } as unknown as Parameters<typeof createDaemonControlApp>[0]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const httpPort = (app.server.address() as AddressInfo).port;

    // The daemon state file goes exactly where the children's configuration looks for it: ask a child.
    const probe = await runDriver('probe.mts', []);
    expect(probe, probe.stderr).toMatchObject({ code: 0 });
    const resolved = parseResult<{ happyHomeDir: string; daemonStateFile: string; candidates: string[] }>(probe.stdout);
    expect(resolved.happyHomeDir).toBe(happierHome);
    expect(resolved.daemonStateFile.startsWith(`${happierHome}/`)).toBe(true);
    expect(resolved.candidates[0]).toBe(resolved.daemonStateFile);

    await mkdir(dirname(resolved.daemonStateFile), { recursive: true });
    await writeFile(resolved.daemonStateFile, JSON.stringify({
      // The client's liveness check probes this pid: the daemon is this process.
      pid: process.pid,
      httpPort,
      startedAt: Date.now(),
      startedWithCliVersion: '0.0.0-multiprocess-test',
      controlToken,
    }), { mode: 0o600 });
  }, 180_000);

  afterAll(async () => {
    for (const child of liveChildren) child.kill('SIGKILL');
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('anchors the registration to the daemon pid through the command exit and the native run, then releases from another process', async () => {
    const materialize = await runDriver('materialize.mts', [configDir]);
    expect(materialize, materialize.stderr).toMatchObject({ code: 0, signal: null });
    expect(materialize.stdout.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    const out = parseResult<{ pid: number; readiness: Record<string, unknown> & { materializationKey: string } }>(materialize.stdout);
    expect(out.pid).toBe(materialize.pid);
    expect(out.readiness).toEqual({
      v: 1,
      status: 'ready',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'fixture',
      materializationKey: expect.stringMatching(/^execution_run:[0-9a-f-]{36}$/),
    });
    expect(resolveAuthForSpawn).toHaveBeenCalledTimes(1);
    expect(isProcessRunning(materialize.pid)).toBe(false);

    // The command has exited; the daemon holds the registration under ITS OWN pid (the one the state file
    // publishes, this process), not the exited command's.
    const targets = refreshTargetsFor('fixture');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ agentId: 'claude', pid: process.pid, materializationKey: out.readiness.materializationKey });
    expect(targets[0]!.pid).not.toBe(materialize.pid);

    // The native workload runs and is killed without any release (SIGKILL, as after a stop timeout).
    const workload = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { env: childEnv, stdio: 'ignore' }));
    workload.kill('SIGKILL');
    expect(await waitForExit(workload)).toEqual({ code: null, signal: 'SIGKILL' });

    // Neither dead pid's cleanup touches the registration, and neither pid can be resolved to it.
    expect(registry.unregisterPid(materialize.pid)).toBeNull();
    expect(registry.unregisterPid(workload.pid!)).toBeNull();
    expect(refreshTargetsFor('fixture')).toEqual(targets);

    const release = await runDriver('release.mts', [out.readiness.materializationKey]);
    expect(release, release.stderr).toMatchObject({ code: 0, signal: null });
    expect(parseResult(release.stdout)).toEqual({ pid: release.pid, released: true });
    expect(refreshTargetsFor('fixture')).toEqual([]);

    // Nothing is left to release, and a second release says so by failing.
    const again = await runDriver('release.mts', [out.readiness.materializationKey]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('native_connected_services_release_failed');
    expect(refreshTargetsFor('fixture')).toEqual([]);
  }, 300_000);

  it('refuses when no daemon is published and registers nothing', async () => {
    const emptyHome = join(root, 'happier-home-without-daemon');
    await mkdir(emptyHome, { recursive: true });
    resolveAuthForSpawn.mockClear();
    const before = registry.listRefreshTargets();

    const materialize = await runDriver('materialize.mts', [configDir], { ...childEnv, HAPPIER_HOME_DIR: emptyHome });
    expect(materialize.code).not.toBe(0);
    expect(materialize.signal).toBeNull();
    expect(materialize.stderr).toContain('native_connected_services_daemon_unavailable');
    expect(materialize.stdout).not.toContain(RESULT_PREFIX);
    expect(resolveAuthForSpawn).not.toHaveBeenCalled();
    expect(registry.listRefreshTargets()).toEqual(before);
  }, 300_000);
});
