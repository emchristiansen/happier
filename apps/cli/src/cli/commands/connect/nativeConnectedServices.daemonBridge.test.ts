import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const { loggerInfoMock, loggerWarnMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

// File-log sink boundary (the real logger writes package log files).
vi.mock('@/ui/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
    infoFile: loggerInfoMock,
    warnFile: loggerWarnMock,
  },
}));

import { createDaemonControlApp } from '@/daemon/controlServer';
import { deriveConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';
import {
  EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH,
  EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH,
  ExecutionRunConnectedServiceMaterializeResponseSchema,
  ExecutionRunConnectedServiceReleaseResponseSchema,
} from '@/daemon/connectedServices/runsBridge/contract';
import {
  createExecutionRunConnectedServicesBridge,
  type ResolveConnectedServiceAuthForRun,
} from '@/daemon/connectedServices/runsBridge/materializeConnectedServicesForRun';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createConnectedServicesAuthUpdatedRestartHandler } from '@/daemon/connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import type { TrackedSession } from '@/daemon/types';

import {
  materializeClaudeProfileForNativeProcess,
  releaseClaudeProfileForNativeProcess,
} from './nativeConnectedServices';

/**
 * The native-process commands against the daemon's own run bridge, runtime registry and control routes
 * (scoped token included). Only the provider materializer behind `resolveConnectedServiceAuthForSpawn`
 * — the unchanged owner every session spawn uses — is replaced, by a stand-in that returns the shape it
 * returns for a Claude subscription profile. The refresh coordinator rewrites exactly the homes of
 * `registry.listRefreshTargets()`, so that list is what these tests read.
 */

const CONTROL_TOKEN = 'control-token';
const RUN_TOKEN = deriveConnectedServiceRunMaterializeToken(CONTROL_TOKEN);
const HOME = '/homes/claude-subscription/fixture/claude/claude-config';
// The daemon's published pid, which the registration is anchored to (this test process plays the
// short-lived materialize command).
const DAEMON_PID = 31337;
const PUBLICATION = { pid: DAEMON_PID, httpPort: 1, startedAt: 1, startedWithCliVersion: '0.0.0-test', controlToken: CONTROL_TOKEN };
const INVENTORY = { items: [{ serviceId: 'claude-subscription', profiles: [{ profileId: 'fixture', status: 'connected' }] }] };

type Resolved = NonNullable<Awaited<ReturnType<ResolveConnectedServiceAuthForRun>>>;

function claudeHomeResolution(bindingsRaw: unknown, configDir = HOME): Resolved {
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

function startDaemonBridge(resolveAuthForSpawn: ResolveConnectedServiceAuthForRun) {
  const registry = new ConnectedServiceRuntimeRegistry();
  const bridge = createExecutionRunConnectedServicesBridge({
    resolveAuthForSpawn,
    runtimeRegistry: registry,
    logger: { debug: vi.fn() },
  });
  const app = createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: CONTROL_TOKEN,
    handleExecutionRunConnectedServiceMaterialize: async (input: Parameters<typeof bridge.materialize>[0]) =>
      await bridge.materialize({ ...input, agentId: 'claude' }),
    handleExecutionRunConnectedServiceRelease: async (input: Parameters<typeof bridge.release>[0]) =>
      await bridge.release(input),
  } as unknown as Parameters<typeof createDaemonControlApp>[0]);

  // The control client's transport, reduced to the routes: a non-200 is an error, a 200 is schema-parsed.
  const post = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: 'POST', url, headers: { 'x-happier-daemon-token': RUN_TOKEN }, payload: payload as object });
    if (response.statusCode !== 200) throw new Error(`daemon ${url} ${response.statusCode}`);
    return (response.json() as { result: unknown }).result;
  };
  const materializeViaDaemon = vi.fn(async (body: unknown) =>
    ExecutionRunConnectedServiceMaterializeResponseSchema.parse(await post(EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH, body)));
  const releaseViaDaemon = vi.fn(async (body: unknown) =>
    ExecutionRunConnectedServiceReleaseResponseSchema.parse(await post(EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH, body)).released);

  const refreshTargetsFor = (profileId: string) => registry.listRefreshTargets()
    .filter((target) => target.bindings.some((b) => b.serviceId === 'claude-subscription' && b.profileId === profileId));

  return { app, post, materializeViaDaemon, releaseViaDaemon, refreshTargetsFor };
}

describe('native Claude profile commands against the daemon run bridge', () => {
  it('keeps the profile registered for refresh after materialize returns, until release', async () => {
    const daemon = startDaemonBridge(async (params) => claudeHomeResolution(params.connectedServicesBindingsRaw));
    try {
      const ready = await materializeClaudeProfileForNativeProcess(
        { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' },
        { listInventory: async () => INVENTORY, readDaemonPublication: async () => PUBLICATION, materializeViaDaemon: daemon.materializeViaDaemon, releaseViaDaemon: daemon.releaseViaDaemon },
      );

      // The materialize command has returned (the CLI process would now exit); the daemon still holds the
      // registration, so refreshes of this profile keep rewriting its home during the native run.
      expect(daemon.refreshTargetsFor('fixture')).toEqual([
        expect.objectContaining({ agentId: 'claude', materializationKey: ready.materializationKey, pid: DAEMON_PID }),
      ]);
      expect(daemon.releaseViaDaemon).not.toHaveBeenCalled();

      await releaseClaudeProfileForNativeProcess({ materializationKey: ready.materializationKey }, { releaseViaDaemon: daemon.releaseViaDaemon });
      expect(daemon.refreshTargetsFor('fixture')).toEqual([]);

      // A repeated release finds nothing and says so.
      await expect(releaseClaudeProfileForNativeProcess(
        { materializationKey: ready.materializationKey },
        { releaseViaDaemon: daemon.releaseViaDaemon },
      )).rejects.toMatchObject({ code: 'native_connected_services_release_failed' });
    } finally {
      await daemon.app.close();
    }
  });

  it('reclaims a materialization the client abandoned (timeout): no registration outlives the failed command', async () => {
    let finishResolution: (() => void) | null = null;
    let markResolving: () => void = () => {};
    const resolving = new Promise<void>((resolve) => {
      markResolving = resolve;
    });
    const daemon = startDaemonBridge((params) => new Promise((resolve) => {
      finishResolution = () => resolve(claudeHomeResolution(params.connectedServicesBindingsRaw));
      markResolving();
    }));
    try {
      let daemonSide: Promise<unknown> | null = null;
      const abandoningMaterialize = vi.fn(async (body: unknown) => {
        // The request reaches the daemon, which starts materializing; the client gives up before it answers.
        daemonSide = daemon.post(EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH, body);
        await resolving;
        throw new Error('daemon control request timed out');
      });
      // The daemon finishes only after the client has started reclaiming.
      const releaseAfterLateSuccess = vi.fn(async (body: unknown) => {
        const released = daemon.releaseViaDaemon(body);
        finishResolution?.();
        return await released;
      });

      await expect(materializeClaudeProfileForNativeProcess(
        { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' },
        { listInventory: async () => INVENTORY, readDaemonPublication: async () => PUBLICATION, materializeViaDaemon: abandoningMaterialize, releaseViaDaemon: releaseAfterLateSuccess },
      )).rejects.toMatchObject({ code: 'native_connected_services_not_materialized' });

      await daemonSide;
      expect(releaseAfterLateSuccess).toHaveBeenCalledTimes(1);
      expect(daemon.refreshTargetsFor('fixture')).toEqual([]);
    } finally {
      await daemon.app.close();
    }
  });

  it('leaves no registration when the daemon prepared a different home', async () => {
    const daemon = startDaemonBridge(async (params) => claudeHomeResolution(params.connectedServicesBindingsRaw, '/elsewhere/claude-config'));
    try {
      await expect(materializeClaudeProfileForNativeProcess(
        { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' },
        { listInventory: async () => INVENTORY, readDaemonPublication: async () => PUBLICATION, materializeViaDaemon: daemon.materializeViaDaemon, releaseViaDaemon: daemon.releaseViaDaemon },
      )).rejects.toMatchObject({ code: 'native_connected_services_expectation_failed' });
      expect(daemon.refreshTargetsFor('fixture')).toEqual([]);
    } finally {
      await daemon.app.close();
    }
  });

  it('registers nothing when materialization fails', async () => {
    const daemon = startDaemonBridge(async () => {
      throw new Error('credential refresh failed');
    });
    try {
      await expect(materializeClaudeProfileForNativeProcess(
        { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' },
        { listInventory: async () => INVENTORY, readDaemonPublication: async () => PUBLICATION, materializeViaDaemon: daemon.materializeViaDaemon, releaseViaDaemon: daemon.releaseViaDaemon },
      )).rejects.toMatchObject({ code: 'native_connected_services_not_materialized' });
      expect(daemon.refreshTargetsFor('fixture')).toEqual([]);
    } finally {
      await daemon.app.close();
    }
  });
  it('a leaked registration (never released) cannot make a profile deletion stop an unrelated session', async () => {
    const daemon = startDaemonBridge(async (params) => claudeHomeResolution(params.connectedServicesBindingsRaw));
    try {
      await materializeClaudeProfileForNativeProcess(
        { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' },
        { listInventory: async () => INVENTORY, readDaemonPublication: async () => PUBLICATION, materializeViaDaemon: daemon.materializeViaDaemon, releaseViaDaemon: daemon.releaseViaDaemon },
      );
      // The caller was killed before release. Its pid, and this command's, are dead and later reused by an
      // unrelated daemon-tracked session on another account.
      const unrelated = { pid: process.pid, happySessionId: 'unrelated-session', startedBy: 'daemon' } as unknown as TrackedSession;
      const pidToTrackedSession = new Map<number, TrackedSession>([[process.pid, unrelated]]);
      const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'stopped' as const }));
      const handler = createConnectedServicesAuthUpdatedRestartHandler({
        pidToTrackedSession,
        resolveLifecycleDescriptor: async () => { throw new Error('unused on deletion'); },
        resolveProcessGroupPid: () => null,
        requestRestartSignal: vi.fn(async () => ({ signaled: true })),
        stopSessionForCredentialDeletion,
        restartSignalDelayMs: 0,
      });
      const binding = { serviceId: 'claude-subscription' as const, profileId: 'fixture' };
      // The deletion path the refresh coordinator takes: every refresh target bound to the profile.
      const affectedTargets = daemon.refreshTargetsFor('fixture');
      expect(affectedTargets).toHaveLength(1);

      await expect(handler({ binding, affectedTargets, mutation: 'deleted', trigger: 'reconnect_propagation' }))
        .rejects.toThrow();
      expect(stopSessionForCredentialDeletion).not.toHaveBeenCalled();

      // The counterexample the anchor prevents: the same registration under the reused pid would stop it.
      await handler({
        binding,
        affectedTargets: affectedTargets.map((target) => ({ ...target, pid: process.pid })),
        mutation: 'deleted',
        trigger: 'reconnect_propagation',
      });
      expect(stopSessionForCredentialDeletion).toHaveBeenCalledWith(expect.objectContaining({ tracked: unrelated }));
    } finally {
      await daemon.app.close();
    }
  });
});
