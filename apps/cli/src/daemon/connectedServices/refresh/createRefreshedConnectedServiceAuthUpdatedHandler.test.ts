import { setImmediate as nextMacrotask } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceSessionAuthSwitchLockRegistry } from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { logger } from '@/ui/logger';
import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';
import {
  createRefreshedConnectedServiceAuthUpdatedHandler,
  type RefreshedConnectedServiceAuthApplication,
} from './createRefreshedConnectedServiceAuthUpdatedHandler';
import type { SpawnTarget } from './refreshTypes';

type Handler = ReturnType<typeof createRefreshedConnectedServiceAuthUpdatedHandler>;
type AuthUpdatedEvent = Parameters<Handler>[0];
type RestartHandlerParams = Parameters<typeof createConnectedServicesAuthUpdatedRestartHandler>[0];
type RestartSignalParams = Parameters<RestartHandlerParams['requestRestartSignal']>[0];

// The handler reads only these fields of a running target; the rest of the registry shape is not
// part of this behaviour.
function spawnTarget(input: Readonly<{
  pid: number;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): SpawnTarget {
  const selection: ConnectedServiceChildSelection = {
    kind: 'profile',
    serviceId: input.serviceId,
    profileId: input.profileId,
    credentialRevision: null,
  };
  return {
    pid: input.pid,
    sessionId: input.sessionId,
    agentId: input.agentId,
    runtimeIdentityKey: `runtime-${input.pid}`,
    selectionsByServiceId: new Map([[input.serviceId, selection]]),
  } as unknown as SpawnTarget;
}

function refreshEvent(
  serviceId: ConnectedServiceId,
  profileId: string,
  affectedTargets: ReadonlyArray<SpawnTarget>,
): AuthUpdatedEvent {
  return {
    binding: { serviceId, profileId },
    affectedTargets,
    credentialRevision: null,
    trigger: 'refresh_triggered_restart',
  };
}

// No other transition holds a session lock, so every session applies at once.
function unlockedSessions() {
  return {
    sessionLocks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
    readCurrentSelection: () => null,
  };
}

function applyResults(
  bySessionId: Readonly<Record<string, Readonly<{ ok: boolean; action?: string; errorCode?: string }>>>,
): RefreshedConnectedServiceAuthApplication {
  return async (input) => bySessionId[input.sessionId] ?? { ok: false, errorCode: 'unexpected_session' };
}

describe('createRefreshedConnectedServiceAuthUpdatedHandler', () => {
  it('leaves a session whose hot-apply needs a restart to the restart policy instead of throwing', async () => {
    // Regression: this used to throw connected_service_refreshed_auth_application_failed:
    // hot_apply_restart_required, which escaped the account changes sync before its cursor saved.
    const restartAfterAuthUpdated = vi.fn(async (_event: AuthUpdatedEvent) => {});
    const onRestartRequired = vi.fn();
    const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
      applyRefreshedAuth: applyResults({ s1: { ok: false, errorCode: 'hot_apply_restart_required' } }),
      restartAfterAuthUpdated,
      onRestartRequired,
      ...unlockedSessions(),
    });
    const event = refreshEvent('claude-subscription', 'work', [
      spawnTarget({ pid: 1, sessionId: 's1', agentId: 'claude', serviceId: 'claude-subscription', profileId: 'work' }),
    ]);

    const result = await handler(event);

    expect(result).toEqual({ appliedRuntimeIdentityKeys: new Set() });
    expect(restartAfterAuthUpdated).toHaveBeenCalledWith(event);
    expect(onRestartRequired).toHaveBeenCalledWith({
      sessionId: 's1',
      pid: 1,
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      errorCode: 'hot_apply_restart_required',
    });
  });

  it('still throws for other application failures, before any restart', async () => {
    const restartAfterAuthUpdated = vi.fn(async (_event: AuthUpdatedEvent) => {});
    const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
      applyRefreshedAuth: applyResults({ s1: { ok: false, errorCode: 'hot_apply_failed' } }),
      restartAfterAuthUpdated,
      onRestartRequired: vi.fn(),
      ...unlockedSessions(),
    });

    await expect(handler(refreshEvent('openai-codex', 'work', [
      spawnTarget({ pid: 1, sessionId: 's1', agentId: 'codex', serviceId: 'openai-codex', profileId: 'work' }),
    ]))).rejects.toThrow('connected_service_refreshed_auth_application_failed:hot_apply_failed');
    expect(restartAfterAuthUpdated).not.toHaveBeenCalled();
  });

  it('reports only hot-applied runtimes as applied when outcomes are mixed', async () => {
    const onRestartRequired = vi.fn();
    const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
      applyRefreshedAuth: applyResults({
        s1: { ok: true, action: 'hot_applied' },
        s2: { ok: false, errorCode: 'hot_apply_restart_required' },
        s3: { ok: false, errorCode: 'restart_disallowed_by_execution_policy' },
      }),
      restartAfterAuthUpdated: async () => {},
      onRestartRequired,
      ...unlockedSessions(),
    });

    const result = await handler(refreshEvent('openai-codex', 'work', [
      spawnTarget({ pid: 1, sessionId: 's1', agentId: 'codex', serviceId: 'openai-codex', profileId: 'work' }),
      spawnTarget({ pid: 2, sessionId: 's2', agentId: 'codex', serviceId: 'openai-codex', profileId: 'work' }),
      spawnTarget({ pid: 3, sessionId: 's3', agentId: 'codex', serviceId: 'openai-codex', profileId: 'work' }),
    ]));

    expect(result).toEqual({ appliedRuntimeIdentityKeys: new Set(['runtime-1']) });
    expect(onRestartRequired).toHaveBeenCalledTimes(1);
    expect(onRestartRequired).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2', pid: 2 }));
  });

  describe('with the real restart handler and lifecycle descriptors', () => {
    async function restartsFor(input: Readonly<{
      agentId: CatalogAgentId;
      serviceId: ConnectedServiceId;
    }>): Promise<ReadonlyArray<RestartSignalParams>> {
      const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
      const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
      const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: 's1' };
      const restartAfterAuthUpdated = createConnectedServicesAuthUpdatedRestartHandler({
        restartRequestedPids: new Set<number>(),
        pidToTrackedSession: new Map([[1, tracked]]),
        resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
        resolveProcessGroupPid: (session) => session.pid,
        requestRestartSignal,
        restartSignalDelayMs: 0,
      } satisfies RestartHandlerParams);
      const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
        applyRefreshedAuth: applyResults({ s1: { ok: false, errorCode: 'hot_apply_restart_required' } }),
        restartAfterAuthUpdated,
        onRestartRequired: () => {},
        ...unlockedSessions(),
      });

      await handler(refreshEvent(input.serviceId, 'work', [
        spawnTarget({ pid: 1, sessionId: 's1', agentId: input.agentId, serviceId: input.serviceId, profileId: 'work' }),
      ]));
      return requestRestartSignal.mock.calls.map(([params]) => params);
    }

    it('does not restart Claude for a refreshed claude-subscription credential, by design', async () => {
      // Claude's descriptor exempts claude-subscription: every runner re-reads the refreshed
      // .credentials.json the daemon writes, so no restart is needed.
      expect(await restartsFor({ agentId: 'claude', serviceId: 'claude-subscription' })).toEqual([]);
    });

    it('requests the gated restart where the descriptor requires one', async () => {
      // Gemini's descriptor requires a restart for a refreshed gemini credential and exempts
      // nothing, so the skipped session gets the handler's deferred, gated restart.
      expect(await restartsFor({ agentId: 'gemini', serviceId: 'gemini' })).toEqual([
        expect.objectContaining({
          pid: 1,
          sessionId: 's1',
          target: expect.objectContaining({ serviceId: 'gemini', profileId: 'work' }),
        }),
      ]);
    });

    it('does not restart Codex either: its session keeps its previous credential', async () => {
      // Codex's descriptor mode is hot_apply, so the restart handler never restarts it. Before this
      // change the same case threw instead; neither restarted the session. A true deferred restart
      // for this case is a separate decision.
      expect(await restartsFor({ agentId: 'codex', serviceId: 'openai-codex' })).toEqual([]);
    });
  });

  describe('when another transition holds a session auth lock', () => {
    const serviceId = 'openai-codex' as const;
    const profileSelection = (profileId: string): ConnectedServiceChildSelection => ({
      kind: 'profile',
      serviceId,
      profileId,
      credentialRevision: null,
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The live application owner takes each session's auth lock, as `switchSessionConnectedServiceAuth`
    // does through `runSerializedConnectedServiceTransition`.
    function lockedApplication(
      locks: ConnectedServiceSessionAuthSwitchLockRegistry,
      applied: string[],
    ): RefreshedConnectedServiceAuthApplication {
      return async (input) => await locks.runExclusive(input.sessionId, async () => {
        applied.push(input.sessionId);
        return { ok: true, action: 'hot_applied' };
      });
    }

    async function holdSessionLock(locks: ConnectedServiceSessionAuthSwitchLockRegistry, sessionId: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const holding = new Promise<void>((resolve) => { entered = resolve; });
      const holder = locks.runExclusive(sessionId, async () => {
        entered();
        await released;
      });
      await holding;
      return { release, holder };
    }

    it('applies every free session, defers the held one without waiting, and applies it once the lock frees', async () => {
      const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
      const applied: string[] = [];
      const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      const held = await holdSessionLock(locks, 's1');
      const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
        applyRefreshedAuth: lockedApplication(locks, applied),
        restartAfterAuthUpdated: async () => {},
        onRestartRequired: vi.fn(),
        sessionLocks: locks,
        readCurrentSelection: () => profileSelection('work'),
      });

      let outcome: unknown = 'still waiting';
      try {
        void Promise.resolve(handler(refreshEvent(serviceId, 'work', [
          spawnTarget({ pid: 1, sessionId: 's1', agentId: 'codex', serviceId, profileId: 'work' }),
          spawnTarget({ pid: 2, sessionId: 's2', agentId: 'codex', serviceId, profileId: 'work' }),
        ]))).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
        // The handler's own work is promise-only, so it has settled once the microtask queue drains.
        await nextMacrotask();

        expect(outcome).toEqual({ appliedRuntimeIdentityKeys: new Set(['runtime-2']) });
        expect(applied).toEqual(['s2']);
        expect(info).toHaveBeenCalledWith(
          '[ConnectedServiceRefresh] Refreshed credential application deferred: session auth lock is held',
          expect.objectContaining({ sessionId: 's1', serviceId, profileId: 'work' }),
        );
      } finally {
        held.release();
        await held.holder;
      }
      await nextMacrotask();
      expect(applied).toEqual(['s2', 's1']);
    });

    it('drops a deferred application when the session switched while it held the lock', async () => {
      const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
      const applied: string[] = [];
      const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      let currentSelection = profileSelection('work');
      const held = await holdSessionLock(locks, 's1');
      const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
        applyRefreshedAuth: lockedApplication(locks, applied),
        restartAfterAuthUpdated: async () => {},
        onRestartRequired: vi.fn(),
        sessionLocks: locks,
        readCurrentSelection: () => currentSelection,
      });

      let outcome: unknown = 'still waiting';
      try {
        void Promise.resolve(handler(refreshEvent(serviceId, 'work', [
          spawnTarget({ pid: 1, sessionId: 's1', agentId: 'codex', serviceId, profileId: 'work' }),
        ]))).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
        await nextMacrotask();
        expect(outcome).toEqual({ appliedRuntimeIdentityKeys: new Set() });
        // The lock holder is the session's own switch, to another profile.
        currentSelection = profileSelection('other');
      } finally {
        held.release();
        await held.holder;
      }
      await nextMacrotask();

      expect(applied).toEqual([]);
      expect(info).toHaveBeenCalledWith(
        '[ConnectedServiceRefresh] Deferred refreshed credential application dropped: session selection changed',
        expect.objectContaining({ sessionId: 's1', serviceId, profileId: 'work' }),
      );
    });

    it('applies at once, in order, a session whose lock the calling transition itself holds', async () => {
      const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
      const applied: string[] = [];
      const handler = createRefreshedConnectedServiceAuthUpdatedHandler({
        applyRefreshedAuth: lockedApplication(locks, applied),
        restartAfterAuthUpdated: async () => {},
        onRestartRequired: vi.fn(),
        sessionLocks: locks,
        readCurrentSelection: () => profileSelection('work'),
      });

      const result = await locks.runExclusive('s1', async () => await handler(refreshEvent(serviceId, 'work', [
        spawnTarget({ pid: 1, sessionId: 's1', agentId: 'codex', serviceId, profileId: 'work' }),
        spawnTarget({ pid: 2, sessionId: 's2', agentId: 'codex', serviceId, profileId: 'work' }),
      ])));

      expect(result).toEqual({ appliedRuntimeIdentityKeys: new Set(['runtime-1', 'runtime-2']) });
      expect(applied).toEqual(['s1', 's2']);
    });
  });
});
