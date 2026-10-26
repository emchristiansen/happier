import { buildConnectedServiceCredentialRecord, ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';
import { resolveClaudeConnectedServiceSwitchContinuity } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceSwitchContinuity';
import { createClaudeConnectedServiceRuntimeAuthAdapter } from '@/backends/claude/connectedServices/createClaudeConnectedServiceRuntimeAuthAdapter';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialScopes';
import { ConnectedServiceSessionAuthSwitchLockRegistry, createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createSessionConnectedServiceAuthHotApply } from '../sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { switchSessionConnectedServiceAuth } from '../sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { createConnectedServiceSwitchDeferralQueue } from '../sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import { agent as openCodeAgent } from '@/backends/opencode';
import { agent as piAgent } from '@/backends/pi';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { TrackedSession } from '@/daemon/types';
import { logger } from '@/ui/logger';
import { createDeferred } from '@/testkit/async/deferred';
import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';

const directLiveExternalTokenInjectionCapability = {
  supportsInTurnApply: true,
  requiresExactRuntimeIdentity: true,
  refreshSelectionResync: 'required',
  authMode: {
    kind: 'external_token_injection',
    surface: 'codex_chatgpt_auth_tokens',
  },
} as const;
afterEach(() => vi.restoreAllMocks());

describe('createConnectedServicesAuthUpdatedRestartHandler', () => {
  type RestartHandlerParams = Parameters<typeof createConnectedServicesAuthUpdatedRestartHandler>[0];
  type RestartSignalParams = Parameters<RestartHandlerParams['requestRestartSignal']>[0];

  it.each([false, true])('logs descriptor lookup completion without changing rejection (reject: %s)', async (reject) => {
    const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const descriptor = createDeferred<ConnectedServiceCredentialLifecycleDescriptor>();
    const entered = createDeferred<void>();
    const failure = new Error('descriptor boundary failure');
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set(),
      pidToTrackedSession: new Map([[1, createTrackedSession({ pid: 1, sessionId: 's1' })]]),
      resolveLifecycleDescriptor: () => { entered.resolve(); return descriptor.promise; },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal: async () => ({ signaled: true }),
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);
    const result = handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });
    const outcome = result.then(() => null, (error: unknown) => error);
    await entered.promise;
    const context = { sessionId: 's1', bindings: [{ serviceId: 'claude-subscription', profileId: 'work', groupId: 'team' }] };
    const records = () => log.mock.calls.filter(([message]) => message === '[DAEMON RUN] Connected-service auth stage').map(([, record]) => record);
    try {
      expect(records()).toEqual([{ ...context, stage: 'descriptor_lookup', phase: 'begin' }]);
    } finally {
      if (reject) descriptor.reject(failure);
      else descriptor.resolve(createLifecycleDescriptor('claude', 'no_restart_required'));
      await outcome;
    }
    expect(await outcome).toBe(reject ? failure : null);
    expect(records()).toEqual([
      { ...context, stage: 'descriptor_lookup', phase: 'begin' },
      { ...context, stage: 'descriptor_lookup', phase: 'end' },
    ]);
  });

  function createTrackedSession(input: Readonly<{
    pid: number;
    sessionId: string;
    startedBy?: TrackedSession['startedBy'];
    spawnOptions?: TrackedSession['spawnOptions'];
  }>): TrackedSession {
    return {
      pid: input.pid,
      startedBy: input.startedBy ?? 'daemon',
      happySessionId: input.sessionId,
      ...(input.spawnOptions ? { spawnOptions: input.spawnOptions } : {}),
    };
  }

  function createLifecycleDescriptor(
    agentId: CatalogAgentId,
    mode: 'restart_required' | 'no_restart_required',
    options: Readonly<{
      noRestartRequiredWhenAccessTokenCallbackServiceIds?: ReadonlyArray<ConnectedServiceId>;
    }> = {},
  ): ConnectedServiceCredentialLifecycleDescriptor {
    return {
      providerId: agentId,
      serviceIds: ['claude-subscription'],
      generationApplicationScope: 'per_session_runtime',
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: {
        mode,
        ...(options.noRestartRequiredWhenAccessTokenCallbackServiceIds
          ? {
              noRestartRequiredWhenAccessTokenCallbackServiceIds:
                options.noRestartRequiredWhenAccessTokenCallbackServiceIds,
            }
          : {}),
      },
      predictiveSoftSwitch: { mode: agentId === 'codex' ? 'supported' : 'unsupported' },
      sameAccountFanoutStrategy: agentId === 'codex' ? 'provider_account_id' : 'none',
      runtimeAuthApply: {
        directLiveHotAuth: agentId === 'codex'
          ? directLiveExternalTokenInjectionCapability
          : 'unsupported',
      },
    };
  }

  function createPlannedRestartRequester(restartRequestedPids: Set<number>, pidToTrackedSession: Map<number, TrackedSession>) {
    return vi.fn((input: RestartSignalParams) => requestPlannedRunnerRestart({
      sessionId: input.sessionId ?? '', tracked: input.tracked, reason: 'connected_service_switch',
      restartRequestedPids, pidToTrackedSession, deferral: { kind: 'none' },
      isProcessSafeToSignal: async () => true, canSignal: async () => await input.shouldSignal?.(),
      // Only the OS signal boundary is synthetic; reservation/currentness use the real owner.
      requestSignal: async ({ shouldSignal }) => await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const },
      logDebug: () => {},
    }));
  }

  it('marks restart-required targets and requests a restart signal without killing the child directly', async () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
      [2, createTrackedSession({ pid: 2, sessionId: 's2' })],
    ]);

    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, agentId === 'claude' ? 'restart_required' : 'no_restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [
        { pid: 1, agentId: 'claude' },
        { pid: 2, agentId: 'codex' },
      ],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(restartRequestedPids.has(2)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      processGroupPid: 1,
      delayMs: 250,
      restartDiagnostic: expect.objectContaining({
        trigger: 'refresh_triggered_restart',
        sessionId: 's1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 7,
      }),
    }));
  });

  it('stops a live target on credential deletion instead of applying restart policy', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'stopped' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    });

    expect(stopSessionForCredentialDeletion).toHaveBeenCalledWith({
      tracked,
      target: { pid: 1, agentId: 'claude' },
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('coalesces turn-deferred credential restarts without holding refresh propagation open', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map([[1, tracked]]);
    const restartRequestedPids = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const signals = vi.fn(async () => ({ status: 'requested' as const }));
    const pending: ReturnType<typeof requestPlannedRunnerRestart>[] = [];
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids, pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (session) => session.pid, restartSignalDelayMs: 0,
      requestRestartSignal: (input) => {
        const request = requestPlannedRunnerRestart({
          sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids, pidToTrackedSession,
          deferral: { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
            target: { serviceId: input.target.serviceId, profileId: input.target.profileId, groupId: input.target.groupId, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue },
          isProcessSafeToSignal: async () => true, canSignal: async () => await input.shouldSignal?.(),
          requestSignal: async ({ shouldSignal }) => await shouldSignal() ? await signals() : { status: 'skipped_stale_owner' as const },
          logDebug: () => {},
        });
        pending.push(request); return request;
      },
    });
    const event = { binding: { serviceId: 'claude-subscription' as const, profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' as const }] };
    try {
      await expect(handler(event)).resolves.toBeUndefined();
      await expect(handler(event)).resolves.toBeUndefined();
      expect(signals).not.toHaveBeenCalled();
      // Pending deduplication belongs to the queue; this Set records actual restart intent.
      expect(restartRequestedPids.size).toBe(0);
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      expect(await Promise.all(pending)).toEqual([{ signaled: true }, { signaled: false }]);
      await Promise.resolve();
      expect(signals).toHaveBeenCalledOnce();
      expect(restartRequestedPids.has(1)).toBe(true);
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled(pending); }
  });

  it('rejects credential deletion acknowledgement when canonical stop reports incomplete termination', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const stopSessionForCredentialDeletion = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: {
        status: 'incomplete',
        reason: 'runner_exit_timeout',
      },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('rejects credential deletion acknowledgement while canonical stop is only requested', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'requested' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: { status: 'requested' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('acknowledges not_found only after the canonical lifecycle owner removed the tracked target', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map([[1, tracked]]);
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const stopSessionForCredentialDeletion = vi.fn(async () => {
      pidToTrackedSession.delete(1);
      return { status: 'not_found' as const };
    });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).resolves.toBeUndefined();
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('rejects not_found when the tracked target still survives', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'not_found' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: { status: 'not_found' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('uses the gated restart path for a demonstrably surviving reattached runner', async () => {
    const restartRequestedPids = new Set<number>();
    const tracked = {
      ...createTrackedSession({ pid: 41, sessionId: 'reattached-session' }),
      reattachedFromDiskMarker: true,
    } satisfies TrackedSession;
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: tracked.pid, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids).toContain(tracked.pid);
  });

  it('does not request a restart for a target that can refresh Claude subscription access tokens through the SDK callback', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, 'restart_required', {
          noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
        }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [
        {
          pid: 1,
          agentId: 'claude',
          accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['claude-subscription'] },
        },
      ],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('never restarts Claude sessions for refreshed claude-subscription credentials with the REAL catalog descriptor (stable home is read live by every runner shape)', async () => {
    // Live incident 2026-07-08: a unified-terminal Claude session (no SDK daemon_callback
    // capability) was restarted on every refresh distribution. The terminal `claude` binary
    // re-reads the stable home's .credentials.json live (user-proven), so NO Claude runner shape
    // needs a restart for a refreshed claude-subscription credential — only account SWITCHES
    // (generation applies, via the switch coordinator) restart sessions.
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    // Unified-terminal shape: NO accessTokenRefresh capability on the target.
    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('keeps restart fallback for targets without an active access-token callback', async () => {
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, 'restart_required', {
          noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
        }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [
        {
          pid: 1,
          agentId: 'claude',
        },
      ],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not let a stale callback marker for another service suppress restart', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required', {
        noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
      }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{
        pid: 1,
        agentId: 'claude',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
  });

  it('fails toward a tracked-session deferral when authoritative callback proof cannot be resolved', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const onRestartBlocked = vi.fn();
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession: new Map<number, TrackedSession>(),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required', {
        noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
      }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
      onRestartBlocked,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{
        pid: 1,
        agentId: 'claude',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(onRestartBlocked).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      reason: 'tracked_session_missing',
    }));
  });

  it('uses the registered Codex callback fact to preserve app-server sessions across same-account OAuth refreshes', async () => {
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({
        pid: 1,
        sessionId: 'codex-app-server',
        spawnOptions: { directory: '/tmp/codex-app-server', codexBackendMode: 'appServer' },
      })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{
        pid: 1,
        agentId: 'codex',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('does not restart Codex when a runtime target lacks the app-server token callback', async () => {
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({
        pid: 1,
        sessionId: 'codex-acp',
        spawnOptions: { directory: '/tmp/codex-acp', codexBackendMode: 'acp' },
      })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: 1, agentId: 'codex' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('does not restart OpenCode or Pi for brokered same-account OAuth refreshes', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
      [2, createTrackedSession({ pid: 2, sessionId: 'pi-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [
        { pid: 1, agentId: 'opencode' },
        { pid: 2, agentId: 'pi' },
      ],
      trigger: 'refresh_triggered_restart',
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });

  it('restarts a Pi claude-subscription SETUP-TOKEN session on reconnect (raw api_key, no broker to hot-apply)', async () => {
    // R3-7: Pi's descriptor no-restart claim for claude-subscription is only truthful for the brokered
    // OAuth shape. A setup-token materializes as a raw api_key baked into auth.json at spawn (no broker
    // env), so a reconnected credential can only reach the running Pi process via a restart. The
    // absence of PI_BROKER_SELECTIONS_ENV on the tracked session marks it as the setup-token shape.
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'pi-setup-token-session' })],
    ]);

    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not restart a Pi claude-subscription OAuth (brokered) session on reconnect', async () => {
    const { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } = await import('@/backends/pi/brokerExtension');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked: TrackedSession = {
      ...createTrackedSession({ pid: 1, sessionId: 'pi-brokered-session' }),
      spawnOptions: {
        directory: '/tmp/pi-brokered-session',
        environmentVariables: {
          [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
            anthropic: { serviceId: 'claude-subscription', profileId: 'work', accountId: null, planType: null },
          }),
        },
      },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (t) => t.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('still restarts OpenCode when a direct API-key connected service is reconnected', async () => {
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
    ]);

    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai', profileId: 'platform-key' },
      affectedTargets: [{ pid: 1, agentId: 'opencode' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('passes the resolved tracked session and gated-restart target to the restart-signal dependency (K3)', async () => {
    // K3: the wiring site routes the restart through the gated deferral primitive
    // (requestConnectedServiceRestartWithDeferral), which needs the tracked
    // session + the switch target descriptor. The handler must therefore hand
    // both to its requestRestartSignal dependency instead of only a bare pid.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      tracked,
      sessionId: 's1',
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 9,
      },
    }));
  });

  it('marks external credential updates as reconnect propagation restart diagnostics', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        sessionId: 's1',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      }),
    }));
  });

  it('classifies refresh and reconnect propagation as non-account-changing gated restarts', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      },
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        reason: 'reconnect_propagation',
      }),
    }));
  });

  it('does not reserve the pid when the gated restart returns WITHOUT signalling (switch_cancelled must not leak the reservation)', async () => {
    // A canonical request cancelled before signalling creates no reservation. The handler must
    // not manufacture one, so a subsequent refresh remains eligible for the same process.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: false }));
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(false);

    // A later refresh for the SAME pid must NOT be suppressed (the reservation did not leak).
    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 10 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });
    expect(requestRestartSignal).toHaveBeenCalledTimes(2);
  });

  it('reserves the pid only when the gated restart actually signalled', async () => {
    const restartRequestedPids = new Set<number>();
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not double-restart the same pid', async () => {
    const restartRequestedPids = new Set<number>([1]);
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(0);
  });

  it('does not mark the pid for restart when restart signaling throws', async () => {
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const requestRestartSignal = vi.fn((input: RestartSignalParams) => requestPlannedRunnerRestart({
      sessionId: 's1', tracked: input.tracked, reason: 'connected_service_switch', restartRequestedPids, pidToTrackedSession,
      deferral: { kind: 'none' }, isProcessSafeToSignal: async () => true,
      canSignal: async () => await input.shouldSignal?.(),
      requestSignal: async ({ shouldSignal, onSignalFailure }) => {
        if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
        const failure = new Error('kill-failed');
        onSignalFailure(failure); // The external signal boundary reports failure to its canonical owner.
        throw failure;
      }, logDebug: () => {},
    }));

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => 1,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    })).resolves.toBeUndefined();

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    await Promise.allSettled(requestRestartSignal.mock.results.map((result) => result.value));
    expect(restartRequestedPids.size).toBe(0);
  });

  it('records a blocked diagnostic when a restart-required target cannot be safely signaled', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async (_params: RestartSignalParams) => ({ signaled: true }));
    const onRestartBlocked = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
      onRestartBlocked,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
    expect(onRestartBlocked).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      agentId: 'claude',
      pid: 1,
      reason: 'unsupported_restart_signal',
      startedBy: 'daemon',
      hasChildProcess: false,
      hasProcessGroupPid: false,
      reattachedFromDiskMarker: false,
    });
  });
  it.each([true, false])('uses an explicit adapter requirement despite a generic exemption while respecting restart-disable (%s)', async (restartEnabled) => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[1, tracked]]);
    const requestRestartSignal = createPlannedRestartRequester(restartRequestedPids, pidToTrackedSession);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids, pidToTrackedSession, restartEnabled,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, requestRestartSignal, restartSignalDelayMs: 0,
    });
    const requiredRestarts = new Map([[1, {
      tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1', isCurrent: async () => true,
      requirement: { kind: 'restart_resume' as const, source: 'failed_adapter_hot_apply' as const, serviceId: 'claude-subscription' as const, profileId: 'work', groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' as const },
    }]]);
    await handler({ binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }], requiredRestarts });
    expect(requestRestartSignal).toHaveBeenCalledTimes(restartEnabled ? 1 : 0);
    expect(restartRequestedPids.has(1)).toBe(restartEnabled);
  });

  it('rechecks captured ownership after an asynchronous final currentness read', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const sessions = new Map([[1, tracked]]);
    const finalRead = createDeferred<boolean>();
    let reads = 0;
    let signalInput: RestartSignalParams | undefined;
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set(), pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, restartSignalDelayMs: 0,
      requestRestartSignal: async (input) => { signalInput = input; return { signaled: false }; },
    });
    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }],
      requiredRestarts: new Map([[1, {
        tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1',
        isCurrent: async () => ++reads === 1 ? true : await finalRead.promise,
        requirement: { kind: 'restart_resume', source: 'failed_adapter_hot_apply', serviceId: 'claude-subscription', profileId: 'work', groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
      }]]),
    });
    expect(signalInput).toBeDefined();
    const eligible = signalInput!.shouldSignal!();
    sessions.set(1, createTrackedSession({ pid: 1, sessionId: 'replacement' }));
    finalRead.resolve(true);
    expect(await eligible).toBe(false);
  });

  it.each(['boundary', 'stale_revision', 'stop', 'superseded', 'manual'] as const)('retains canonical deferral and reservation behavior for a required restart: %s', async (mode) => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const sessions = new Map([[1, tracked]]);
    const reservations = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const target = { serviceId: 'claude-subscription' as const, profileId: 'work', groupId: 'team', generation: 7 };
    let current = true;
    const signals: number[] = [];
    const manual = mode === 'manual' ? queue.requestSwitch({ sessionId: 's1', source: 'manual', policy: 'defer_until_turn_boundary', target, runSwitch: async () => {} }) : Promise.resolve();
    const pending: Promise<unknown>[] = [manual];
    const requestRestartSignal = vi.fn((input: RestartSignalParams) => {
      const request = requestPlannedRunnerRestart({
        sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
        deferral: { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary', target: { ...input.target, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue },
        isProcessSafeToSignal: async () => true,
        canSignal: async () => await input.shouldSignal?.(),
        requestSignal: async ({ shouldSignal }) => {
          if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
          signals.push(tracked.pid); return { status: 'requested' as const };
        }, logDebug: () => {},
      });
      pending.push(request); return request;
    });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, requestRestartSignal, restartSignalDelayMs: 0,
    });
    const event = {
      binding: target, affectedTargets: [{ pid: 1, agentId: 'claude' as const }],
      requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1', isCurrent: async () => current,
        requirement: { ...target, kind: 'restart_resume' as const, source: 'failed_adapter_hot_apply' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuv' as const },
      }]]),
    };
    try {
      await handler(event);
      if (mode !== 'manual') await handler(event);
      expect(signals).toEqual([]);
      if (mode === 'stale_revision') current = false;
      if (mode === 'stop') queue.cancelSession('s1', 'session_terminated');
      if (mode === 'superseded') pending.push(queue.requestSwitch({ sessionId: 's1', source: 'automatic', policy: 'defer_until_turn_boundary', target: { ...target, generation: 8 }, runSwitch: async () => {} }));
      // A failed turn releases the boundary; it is not provider-account verification.
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'turn_cancelled' });
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      await Promise.allSettled(pending);
      await Promise.resolve();
      expect(signals).toEqual(mode === 'boundary' ? [1] : []);
      expect(reservations.has(1)).toBe(mode === 'boundary');
      expect(requestRestartSignal).toHaveBeenCalledTimes(mode === 'manual' ? 1 : 2);
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled(pending); }
  });

  it('preserves a queued manual restart reservation when the automatic required request joins without signalling', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    // Synthetic child boundary: no process is spawned or signalled.
    tracked.childProcess = { exitCode: null, signalCode: null } as NonNullable<TrackedSession['childProcess']>;
    const sessions = new Map([[1, tracked]]);
    const reservations = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const descriptorEntered = createDeferred<void>();
    const descriptor = createDeferred<ConnectedServiceCredentialLifecycleDescriptor>();
    const subscription = { serviceId: 'claude-subscription' as const, profileId: 'work', groupId: 'team', generation: 7 };
    const signals: string[] = [];
    let automatic: ReturnType<typeof requestPlannedRunnerRestart> | undefined;
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: () => { descriptorEntered.resolve(); return descriptor.promise; },
      resolveProcessGroupPid: () => 1, restartSignalDelayMs: 0,
      requestRestartSignal: (input) => {
        automatic = requestPlannedRunnerRestart({
          sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
          deferral: { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary', target: { ...input.target, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue },
          isProcessSafeToSignal: async () => true, canSignal: async () => await input.shouldSignal?.(),
          requestSignal: async ({ shouldSignal }) => {
            if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
            signals.push('automatic'); return { status: 'requested' as const };
          }, logDebug: () => {},
        });
        return automatic;
      },
    });
    // The application has completed before this handler's descriptor await. An unrelated
    // anthropic switch retains the subscription selection and its authoritative revision.
    const application = handler({
      binding: subscription, affectedTargets: [{ pid: 1, agentId: 'claude' }],
      requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1', isCurrent: async () => true,
        requirement: { ...subscription, kind: 'restart_resume', source: 'failed_adapter_hot_apply', credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
      }]]),
    });
    await descriptorEntered.promise;
    // This is the actual daemon target for a full multi-service manual request.
    const manual = requestPlannedRunnerRestart({
      sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
      deferral: { kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
        target: { serviceId: '__multi_service_switch__', profileId: '', groupId: '', generation: 0 }, turnDeferralQueue: queue },
      isProcessSafeToSignal: async () => true,
      requestSignal: async ({ shouldSignal }) => {
        if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
        signals.push('manual'); return { status: 'requested' as const };
      }, logDebug: () => {},
    });
    try {
      expect(reservations.size).toBe(0);
      descriptor.resolve(createLifecycleDescriptor('claude', 'no_restart_required'));
      await application;
      expect(automatic).toBeDefined();
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      expect(await manual).toEqual({ signaled: true });
      expect(await automatic).toEqual({ signaled: false });
      await Promise.resolve();
      expect(signals).toEqual(['manual']);
      // The daemon's existing exit consumer reads this Set to select forced respawn.
      // Child exit is deliberately delayed until both request settlements have completed.
      expect(reservations.has(tracked.pid)).toBe(true);
    } finally {
      descriptor.resolve(createLifecycleDescriptor('claude', 'no_restart_required'));
      queue.cancelAll('daemon_shutdown');
      await Promise.allSettled([application, manual, ...(automatic ? [automatic] : [])]);
    }
  });

  it.each(['exitCode', 'signalCode', 'killed'] as const)('uses terminal child evidence rather than signal-request state before authority: %s', async (field) => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    // ChildProcess-shaped OS boundary; killed alone does not establish that the child exited.
    tracked.childProcess = {
      exitCode: field === 'exitCode' ? 0 : null,
      signalCode: field === 'signalCode' ? 'SIGTERM' : null,
      killed: field === 'killed',
    } as NonNullable<TrackedSession['childProcess']>;
    const reservations = new Set<number>();
    const requestRestartSignal = createPlannedRestartRequester(reservations, new Map([[1, tracked]]));
    const current = vi.fn(async () => true);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, requestRestartSignal, restartSignalDelayMs: 0,
    });
    await handler({ binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }],
      requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1', isCurrent: current,
        requirement: { kind: 'restart_resume', source: 'failed_adapter_hot_apply', serviceId: 'claude-subscription', profileId: 'work', groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
      }]]),
    });
    if (field === 'killed') {
      expect(await requestRestartSignal.mock.results[0]?.value).toEqual({ signaled: true });
      expect(reservations.has(1)).toBe(true);
    } else {
      expect(current).not.toHaveBeenCalled();
      expect(requestRestartSignal).not.toHaveBeenCalled();
      expect(reservations.size).toBe(0);
    }
  });

  it.each(['exitCode', 'signalCode'] as const)('refuses a retained child whose %s becomes terminal during final authority', async (terminalField) => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const child = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
    // Synthetic ChildProcess state models exit staging retaining the same tracked owner.
    tracked.childProcess = child as NonNullable<TrackedSession['childProcess']>;
    const sessions = new Map([[1, tracked]]);
    const reservations = new Set<number>();
    const authorityEntered = createDeferred<void>();
    const authority = createDeferred<boolean>();
    let reads = 0;
    const signals: number[] = [];
    const safety = vi.fn(async () => true);
    let restart: ReturnType<typeof requestPlannedRunnerRestart> | undefined;
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, restartSignalDelayMs: 0,
      requestRestartSignal: (input) => {
        restart = requestPlannedRunnerRestart({
          sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
          deferral: { kind: 'none' }, isProcessSafeToSignal: safety, canSignal: async () => await input.shouldSignal?.(),
          requestSignal: async ({ shouldSignal }) => {
            if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
            signals.push(1); return { status: 'requested' as const };
          }, logDebug: () => {},
        });
        return restart;
      },
    });
    try {
      await handler({ binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }],
        requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1',
          isCurrent: async () => { if (++reads === 1) return true; authorityEntered.resolve(); return await authority.promise; },
          requirement: { kind: 'restart_resume', source: 'failed_adapter_hot_apply', serviceId: 'claude-subscription', profileId: 'work', groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
        }]]),
      });
      await authorityEntered.promise;
      expect(safety).toHaveBeenCalledOnce();
      if (terminalField === 'exitCode') child.exitCode = 0;
      else child.signalCode = 'SIGTERM';
      expect(sessions.get(1)).toBe(tracked);
      authority.resolve(true);
      expect(await restart).toMatchObject({ signaled: false });
      expect(signals).toEqual([]);
      expect(reservations.size).toBe(0);
    } finally { authority.resolve(true); await restart; }
  });
  it.each([true, false])('executes the current revision after two serialized real Claude failed-adapter requirements roll back (distinct: %s)', async (distinct) => {
    const serviceId = 'claude-subscription' as const;
    const target = { serviceId, profileId: 'work', groupId: 'team', generation: 7 };
    // The spawn owner deliberately omits profileId on the raw group binding.
    const rawBindings = { v: 1 as const, bindingsByServiceId: {
      [serviceId]: { source: 'connected' as const, selection: 'group' as const, groupId: 'team' },
    } };
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1', spawnOptions: {
      directory: '/synthetic/project', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServices: rawBindings,
      environmentVariables: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
        kind: 'group', serviceId, groupId: 'team', activeProfileId: 'work', fallbackProfileId: 'work',
        generation: 7, credentialRevision: 'csr_originalabcdefghijklmnop',
      }]) },
    } });
    tracked.childProcess = { exitCode: null, signalCode: null } as NonNullable<TrackedSession['childProcess']>;
    const sessions = new Map([[1, tracked]]);
    const reservations = new Set<number>();
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    const core = createConnectedServiceSessionAuthSwitchCore({ locks });
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const r1 = 'csr_zzzzzzzzzzzzzzzzzzzzzzzz';
    const r2 = distinct ? 'csr_aaaaaaaaaaaaaaaaaaaaaaaa' : r1;
    let authoritativeRevision = r1;
    const signals: string[] = [];
    const requests: ReturnType<typeof requestPlannedRunnerRestart>[] = [];
    const requestRestartSignal = vi.fn((input: RestartSignalParams) => {
      const request = requestPlannedRunnerRestart({
        sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
        deferral: { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
          target: { ...input.target, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue },
        isProcessSafeToSignal: async () => true, canSignal: async () => await input.shouldSignal?.(),
        requestSignal: async ({ shouldSignal }) => {
          if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
          signals.push(authoritativeRevision); return { status: 'requested' as const };
        }, logDebug: () => {},
      });
      requests.push(request); return request;
    });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, requestRestartSignal, restartSignalDelayMs: 0,
    });
    const persist = vi.fn(async () => {});
    const register = vi.fn();
    const verify = vi.fn();
    const restartInline = vi.fn();
    const continuation = vi.fn();
    const continuityModes: string[] = [];
    const adapterFailure = vi.fn(async () => ({ applied: false as const, recovery: 'restart_resume' as const }));
    const hotApply = createSessionConnectedServiceAuthHotApply({
      // Only the adapter result is synthetic. This does not execute a filesystem fault or provider.
      resolveRuntimeAuthAdapter: async () => ({ ...createClaudeConnectedServiceRuntimeAuthAdapter(), hotApply: adapterFailure }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000, serviceId, profileId: 'work', kind: 'oauth', expiresAt: 301_000,
      oauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE, tokenType: 'Bearer', providerAccountId: 'synthetic-account', providerEmail: 'synthetic@example.test' },
    });
    const produce = async (credentialRevision: string) => {
      const result = await switchSessionConnectedServiceAuth({
        core, getChildren: () => [tracked],
        executionPolicy: { allowRestartResume: false, allowContinuation: false, source: 'startup_reconciliation' },
        switchReason: 'automatic_runtime_failure', expectedCredentialRevisionByServiceId: { [serviceId]: credentialRevision },
        api: {
          listConnectedServiceProfiles: async () => ({ serviceId, profiles: [{ profileId: 'work', status: 'connected' }] }),
          getConnectedServiceAuthGroup: async () => ({ v: 1, ...target, activeProfileId: 'work', displayName: 'Team',
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), runtimeStateRevision: 0, state: { v: 1 },
            members: [{ v: 1, serviceId, groupId: 'team', profileId: 'work', priority: 100, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }],
            createdAt: 1, updatedAt: 1 }),
        },
        materializeRuntimeAuthSelection: async () => ({ serviceId, record, groupId: 'team', activeProfileId: 'work', generation: 7,
          credentialRevision, targetMaterializedRoot: '/synthetic/group', targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/synthetic/group/claude' },
          claudeRuntimeAuthSharedGroupSurface: { mode: 'shared_group_auth_surface', runtimeClaudeConfigDir: '/synthetic/group/claude',
            runtimeMaterializedRoot: '/synthetic/group', sourceClaudeConfigDir: '/synthetic/source' } }),
        resolveContinuity: async ({ previous, next, previousBindings, normalizedBindings, runtimeAuthSelection }) => {
          const result = await resolveClaudeConnectedServiceSwitchContinuity({ sessionId: 's1', agentId: 'claude', serviceId,
            previousBinding: previous, nextBinding: next, fromBindings: previousBindings, toBindings: normalizedBindings,
            runtimeAuthSelection, targetMaterializedRoot: '/synthetic/group', targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/synthetic/group/claude' } });
          continuityModes.push(result.mode);
          if (result.mode !== 'hot_apply') throw new Error('real Claude group continuity must permit hot apply');
          return { mode: result.mode };
        },
        hotApply, persistSessionBindings: persist, registerHotApplyTargets: register, emitSessionEvent: vi.fn(),
        restartSession: restartInline, continueAfterRuntimeAuthSwitch: continuation, verifyProviderAccountAdoption: verify,
        request: { sessionId: 's1', agentId: 'claude', bindings: { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'team', profileId: 'work' } } }, expectedGroupGenerationByServiceId: { [serviceId]: 7 } },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'hot_apply_failed', restartRequirement: expect.any(Object) });
      if (result.ok || !result.restartRequirement) throw new Error('actual failed adapter must produce its typed restart requirement');
      expect(result.restartRequirement).toEqual({ kind: 'restart_resume', source: 'failed_adapter_hot_apply', ...target, credentialRevision });
      expect(tracked.spawnOptions?.connectedServices).toEqual(rawBindings);
      expect(locks.isHeldByAnotherOwner('s1')).toBe(false);
      await handler({ binding: target, affectedTargets: [{ pid: 1, agentId: 'claude' }],
        requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-original',
          requirement: result.restartRequirement, isCurrent: async () => authoritativeRevision === credentialRevision }]]) });
    };
    try {
      await produce(r1);
      expect(reservations.size).toBe(0);
      authoritativeRevision = r2;
      await produce(r2);
      expect(adapterFailure).toHaveBeenCalledTimes(2);
      expect(continuityModes).toEqual(['hot_apply', 'hot_apply']);
      expect(persist).toHaveBeenCalledTimes(4); // update plus successful rollback for each attempt
      expect(signals).toEqual([]);
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      const outcomes = await Promise.all(requests);
      expect(signals).toEqual([r2]);
      expect(outcomes).toEqual(distinct
        ? [{ signaled: false, notSignaledReason: 'superseded' }, { signaled: true }]
        : [{ signaled: true }, { signaled: false }]);
      expect(reservations.has(1)).toBe(true);
      expect(requestRestartSignal.mock.calls.map(([input]) => input.target)).toEqual([
        { ...target, credentialRevision: r1 }, { ...target, credentialRevision: r2 },
      ]);
      expect(register).not.toHaveBeenCalled();
      expect(restartInline).not.toHaveBeenCalled();
      expect(continuation).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled(requests); }
  });

  it.each(['stale', 'unavailable'] as const)('refuses a required revision when final authority becomes %s', async (mode) => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const sessions = new Map([[1, tracked]]);
    const reservations = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    let current = true;
    const signal = vi.fn(async () => ({ status: 'requested' as const }));
    let pending: ReturnType<typeof requestPlannedRunnerRestart> | undefined;
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: reservations, pidToTrackedSession: sessions,
      resolveLifecycleDescriptor: async () => createLifecycleDescriptor('claude', 'no_restart_required'),
      resolveProcessGroupPid: () => 1, restartSignalDelayMs: 0,
      requestRestartSignal: (input) => {
        pending = requestPlannedRunnerRestart({
          sessionId: 's1', tracked, reason: 'connected_service_switch', restartRequestedPids: reservations, pidToTrackedSession: sessions,
          deferral: { kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
            target: { ...input.target, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue },
          isProcessSafeToSignal: async () => true, canSignal: async () => await input.shouldSignal?.(),
          requestSignal: async ({ shouldSignal }) => await shouldSignal() ? await signal() : { status: 'skipped_stale_owner' as const }, logDebug: () => {},
        });
        return pending;
      },
    });
    try {
      await handler({ binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }],
        requiredRestarts: new Map([[1, { tracked, sessionId: 's1', runtimeIdentityKey: 'runtime-1',
          isCurrent: async () => { if (!current && mode === 'unavailable') throw new Error('synthetic unavailable authority'); return current; },
          requirement: { kind: 'restart_resume', source: 'failed_adapter_hot_apply', serviceId: 'claude-subscription', profileId: 'work',
            groupId: null, generation: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
        }]]) });
      current = false;
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      expect(await pending).toMatchObject({ signaled: false });
      expect(signal).not.toHaveBeenCalled();
      expect(reservations.size).toBe(0);
    } finally { queue.cancelAll('daemon_shutdown'); await pending; }
  });

});
