import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const { loggerMock, publication } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), infoFile: vi.fn(), warnFile: vi.fn() },
  // What the daemon state file publishes right now; the control client's unpinned path reads it per request.
  publication: { current: null as unknown },
}));

// File-log sink boundary (the real logger writes package log files).
vi.mock('@/ui/logger', () => ({ logger: loggerMock }));
// The daemon publication boundary: the real control client reads it through readDaemonState.
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readDaemonState: vi.fn(async () => publication.current),
}));

import { prepareExecutionRunConnectedServices } from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createConnectedServicesAuthUpdatedRestartHandler } from '@/daemon/connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import { createExecutionRunConnectedServicesBridge } from '@/daemon/connectedServices/runsBridge/materializeConnectedServicesForRun';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import type { TrackedSession } from '@/daemon/types';
import type { DaemonLocallyPersistedState } from '@/persistence';

import { materializeClaudeProfileForNativeProcess, releaseClaudeProfileForNativeProcess } from './nativeConnectedServices';

/**
 * DF-01 (review t_7e404b21 r1): a daemon replaced between the native command's publication read and its
 * materialize request must never admit a registration under its predecessor's pid, whatever happens to
 * the release afterwards. Real control client transport (default, unpinned and pinned), real loopback
 * control routes and scoped tokens, real run bridge, registry and credential-deletion handler. Only the
 * provider materializer (a synthetic home, no credential), the inventory, the publication boundary and
 * the release failure are stand-ins. PID reuse is represented in the tracked-session map.
 */

const HOME = '/synthetic/homes/claude-subscription/fixture/claude/claude-config';
const INVENTORY = { items: [{ serviceId: 'claude-subscription', profiles: [{ profileId: 'fixture', status: 'connected' }] }] };
const BINDING = { serviceId: 'claude-subscription' as const, profileId: 'fixture' };

type Daemon = Readonly<{
  app: ReturnType<typeof createDaemonControlApp>;
  registry: ConnectedServiceRuntimeRegistry;
  port: number;
  materializeCalls: () => number;
  publication: (pid: number) => DaemonLocallyPersistedState;
}>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  publication.current = null;
});

async function startDaemon(input: Readonly<{ controlToken: string; port?: number; releaseFails?: boolean }>): Promise<Daemon> {
  const registry = new ConnectedServiceRuntimeRegistry();
  const bridge = createExecutionRunConnectedServicesBridge({
    runtimeRegistry: registry,
    logger: { debug: vi.fn() },
    resolveAuthForSpawn: async (params) => ({
      env: { CLAUDE_CONFIG_DIR: HOME },
      materializationRoot: HOME,
      cleanupMaterializationRoot: null,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: ConnectedServiceBindingsV1Schema.parse(params.connectedServicesBindingsRaw),
      runtimeAccountIdentitySelections: [],
    }),
  });
  let materializeCalls = 0;
  const app = createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: input.controlToken,
    handleExecutionRunConnectedServiceMaterialize: async (request: Parameters<typeof bridge.materialize>[0]) => {
      materializeCalls += 1;
      return await bridge.materialize({ ...request, agentId: 'claude' });
    },
    handleExecutionRunConnectedServiceRelease: async (request: Parameters<typeof bridge.release>[0]) => {
      if (input.releaseFails) throw new Error('synthetic lost release');
      return await bridge.release(request);
    },
  } as unknown as Parameters<typeof createDaemonControlApp>[0]);
  await app.listen({ port: input.port ?? 0, host: '127.0.0.1' });
  cleanups.push(async () => { await app.close(); });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    registry,
    port,
    materializeCalls: () => materializeCalls,
    publication: (pid) => ({ pid, httpPort: port, startedAt: Date.now(), startedWithCliVersion: '0.0.0-test', controlToken: input.controlToken }),
  };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

function livePid(): number {
  const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  cleanups.push(() => { child.kill('SIGKILL'); });
  return child.pid!;
}

/** The real deletion consumer, with an unrelated other-account session tracked at `reusedPid`. */
async function deleteProfileWithUnrelatedSessionAt(daemon: Daemon, reusedPid: number): Promise<number> {
  const unrelated = { pid: reusedPid, happySessionId: 'unrelated-other-account', startedBy: 'daemon' } as unknown as TrackedSession;
  const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'stopped' as const }));
  const handler = createConnectedServicesAuthUpdatedRestartHandler({
    pidToTrackedSession: new Map([[reusedPid, unrelated]]),
    resolveLifecycleDescriptor: async () => { throw new Error('unused on deletion'); },
    resolveProcessGroupPid: () => null,
    requestRestartSignal: vi.fn(async () => ({ signaled: true })),
    stopSessionForCredentialDeletion,
    restartSignalDelayMs: 0,
  });
  // The coordinator's deletion inputs: every refresh target bound to the profile.
  const affectedTargets = daemon.registry.listRefreshTargets()
    .filter((target) => target.bindings.some((b) => b.serviceId === BINDING.serviceId && b.profileId === BINDING.profileId));
  await handler({ binding: BINDING, affectedTargets, mutation: 'deleted', trigger: 'reconnect_propagation' }).catch(() => {});
  return stopSessionForCredentialDeletion.mock.calls.length;
}

/**
 * Daemon A is published; between the caller's read and its request, A is replaced on the same port by
 * daemon B (fresh control token, its own registry) and the publication now names B.
 */
async function replacedOnSamePort(oldPid: number, releaseFails: boolean) {
  const a = await startDaemon({ controlToken: 'daemon-a-token' });
  publication.current = a.publication(oldPid);
  let b: Daemon | null = null;
  const readDaemonPublication = async () => {
    const selected = publication.current as DaemonLocallyPersistedState;
    await a.app.close();
    b = await startDaemon({ controlToken: 'daemon-b-token', port: a.port, releaseFails });
    publication.current = b.publication(process.pid);
    return selected;
  };
  return { readDaemonPublication, replacement: () => b! };
}

describe('native preparation across a daemon replacement (DF-01)', () => {
  it('control: with no replacement it registers under the publishing daemon pid and releases', async () => {
    const a = await startDaemon({ controlToken: 'daemon-a-token' });
    publication.current = a.publication(process.pid);
    const ready = await materializeClaudeProfileForNativeProcess(
      { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/synthetic' },
      { listInventory: async () => INVENTORY },
    );
    expect(a.registry.listRefreshTargets()).toEqual([
      expect.objectContaining({ pid: process.pid, materializationKey: ready.materializationKey }),
    ]);
    await releaseClaudeProfileForNativeProcess({ materializationKey: ready.materializationKey });
    expect(a.registry.listRefreshTargets()).toEqual([]);
  });

  it.each([
    ['alive (its pid now belongs to another process)', true],
    ['gone', false],
  ])('a replacement never admits the predecessor pid, even when release is lost (old pid %s)', async (_label, oldAlive) => {
    const oldPid = oldAlive ? livePid() : await exitedPid();
    const { readDaemonPublication, replacement } = await replacedOnSamePort(oldPid, true);

    await expect(materializeClaudeProfileForNativeProcess(
      { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/synthetic' },
      { listInventory: async () => INVENTORY, readDaemonPublication },
    )).rejects.toMatchObject({ code: 'native_connected_services_not_materialized' });

    const b = replacement();
    expect(b.materializeCalls()).toBe(0);
    expect(b.registry.listRefreshTargets()).toEqual([]);
    expect(await deleteProfileWithUnrelatedSessionAt(b, oldPid)).toBe(0);
  });

  it('contrast: the unpinned transport re-reads the publication and admits the predecessor pid (the DF-01 stop)', async () => {
    const oldPid = livePid();
    const { readDaemonPublication, replacement } = await replacedOnSamePort(oldPid, true);
    const selected = await readDaemonPublication();

    // The retained review1 composition: anchor from the first read, transport reads the publication again.
    await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'fixture' } } },
      credentials: null,
      cwd: '/synthetic',
      registrationPid: selected.pid,
    }).then(async (prepared) => { await prepared?.cleanup(); });

    const b = replacement();
    expect(b.materializeCalls()).toBe(1);
    expect(b.registry.listRefreshTargets()).toEqual([expect.objectContaining({ pid: oldPid })]);
    expect(await deleteProfileWithUnrelatedSessionAt(b, oldPid)).toBe(1);
  });
});
