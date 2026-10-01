import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
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
});
