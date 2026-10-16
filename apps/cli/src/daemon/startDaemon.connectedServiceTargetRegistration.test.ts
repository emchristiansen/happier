import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import {
  registerConnectedServiceTrackedSessionTargetsForDaemon,
  commitRuntimeAuthRecoveryDiagnosticForDaemon,
} from './startDaemon';
import { buildRuntimeAuthRecoveryAttemptTransitionLocalId } from './connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';
import type { TrackedSession } from './types';

describe('registerConnectedServiceTrackedSessionTargetsForDaemon', () => {
  function createClaudeTrackedSession(metadata: Record<string, unknown> = {}): TrackedSession {
    const connectedServiceSelectionsEnv = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'claude-primary',
      }]),
    };
    return {
      pid: 6610,
      startedBy: 'daemon',
      happySessionId: 'sess-claude-connected-service',
      reattachedFromDiskMarker: true,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/claude-workspace',
        host: 'test-host',
        startedBy: 'daemon',
        ...metadata,
      } as TrackedSession['happySessionMetadataFromLocalWebhook'],
      spawnOptions: {
        directory: '/tmp/claude-workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_claude_connected_service',
          createdAtMs: 1_000,
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'claude-primary',
            },
          },
        },
        environmentVariables: connectedServiceSelectionsEnv,
      },
    };
  }

  it('does not infer a Claude refresh callback from connected-service registration', () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked: createClaudeTrackedSession(),
      runtimeRegistry,
    });

    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();
  });

  it('rejects an older Claude launcher callback claim and clears prior registry capability', () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();

    const tracked = createClaudeTrackedSession({
      claudeSubscriptionAccessTokenRefreshV1: { v: 1, mode: 'daemon_callback' },
    });
    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked,
      runtimeRegistry,
    });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();

    // A daemon upgraded with existing registry knowledge must replace it, too.
    const target = runtimeRegistry.getByPid(6610);
    if (!target) throw new Error('Expected registered Claude target');
    runtimeRegistry.registerTarget({ ...target, accessTokenRefresh: {
      mode: 'daemon_callback',
      serviceIds: ['claude-subscription'],
    } });
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();
  });

  it('clears Claude callback capability when the runtime reports the legacy fallback', () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked: createClaudeTrackedSession({
        claudeSubscriptionAccessTokenRefreshV1: {
          v: 1,
          mode: 'daemon_callback',
        },
      }),
      runtimeRegistry,
    });
    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked: createClaudeTrackedSession({
        claudeSubscriptionAccessTokenRefreshV1: {
          v: 1,
          mode: 'unavailable',
        },
      }),
      runtimeRegistry,
    });

    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();
  });

  it('registers and replaces a provider-reported Codex app-server refresh callback capability', () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const tracked = createClaudeTrackedSession({
      flavor: 'codex',
      connectedServiceAccessTokenRefreshV1: {
        v: 1,
        mode: 'daemon_callback',
        serviceIds: ['openai-codex'],
      },
    });
    tracked.spawnOptions = {
      ...tracked.spawnOptions,
      directory: '/tmp/codex-workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-primary' },
        },
      },
    };

    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toEqual({
      mode: 'daemon_callback',
      serviceIds: ['openai-codex'],
    });

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: undefined,
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: {
        v: 1,
        mode: 'daemon_callback',
        serviceIds: ['openai-codex'],
      },
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: { v: 1, mode: 'unavailable', serviceIds: ['openai-codex'] },
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: {
        v: 1,
        mode: 'daemon_callback',
        serviceIds: ['openai-codex'],
      },
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: { v: 1, mode: 'daemon_callback', serviceIds: null },
    } as unknown as TrackedSession['happySessionMetadataFromLocalWebhook'];
    expect(() => registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry })).not.toThrow();
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();

    runtimeRegistry.unregisterPid(6610);
    expect(runtimeRegistry.getByPid(6610)).toBeNull();
  });

  it('publishes the Codex callback fact after startup registration and preserves it across a changed generation', () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const tracked = createClaudeTrackedSession({ flavor: 'codex' });
    if (!tracked.spawnOptions) throw new Error('Expected tracked spawn options fixture');
    tracked.spawnOptions = {
      ...tracked.spawnOptions,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'codex-a' },
        },
      },
      environmentVariables: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'codex-a',
          fallbackProfileId: 'codex-b',
          generation: 7,
        }]),
      },
    };

    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: {
        v: 1,
        mode: 'daemon_callback',
        serviceIds: ['openai-codex'],
      },
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toEqual({
      mode: 'daemon_callback',
      serviceIds: ['openai-codex'],
    });

    tracked.spawnOptions.environmentVariables = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'codex-b',
        fallbackProfileId: 'codex-a',
        generation: 8,
      }]),
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)).toMatchObject({
      accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      activeBindings: [expect.objectContaining({ groupId: 'team', generation: 8 })],
    });

    tracked.happySessionMetadataFromLocalWebhook = {
      ...tracked.happySessionMetadataFromLocalWebhook!,
      connectedServiceAccessTokenRefreshV1: {
        v: 1,
        mode: 'unavailable',
        serviceIds: ['openai-codex'],
      },
    };
    registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry });
    expect(runtimeRegistry.getByPid(6610)?.accessTokenRefresh).toBeNull();
  });

  it('registers a reattached connected-service session directly with the runtime registry', () => {
    const connectedServiceSelectionsEnv = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'codex1',
        fallbackProfileId: 'codex2',
        generation: 7,
      }]),
    };
    const tracked: TrackedSession = {
      pid: 6510,
      startedBy: 'daemon',
      happySessionId: 'sess-reattached-connected-service',
      reattachedFromDiskMarker: true,
      spawnOptions: {
        directory: '/tmp/reattached-workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_reattached_connected_service',
          createdAtMs: 1_000,
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
              profileId: 'codex1',
            },
          },
        },
        environmentVariables: connectedServiceSelectionsEnv,
      },
    };
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const onRuntimeTargetRegistration = vi.fn();
    runtimeRegistry.onTargetRegistration(onRuntimeTargetRegistration);

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked,
      runtimeRegistry,
    });

    expect(runtimeRegistry.getByPid(6510)).toMatchObject({
      pid: 6510,
      agentId: 'codex',
      sessionId: 'sess-reattached-connected-service',
      materializationKey: 'csm_reattached_connected_service',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_reattached_connected_service',
        createdAtMs: 1_000,
      },
      sessionDirectory: '/tmp/reattached-workspace',
      connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
      connectedServiceSelectionsEnv,
    });
    expect(runtimeRegistry.getBySessionId('sess-reattached-connected-service')?.pid).toBe(6510);
    expect(runtimeRegistry.listRefreshTargets()).toHaveLength(1);
    expect(runtimeRegistry.listQuotaTargets()).toHaveLength(1);
    expect(onRuntimeTargetRegistration).toHaveBeenCalledWith(expect.objectContaining({
      key: { kind: 'session', pid: 6510 },
      target: runtimeRegistry.getByPid(6510),
    }));
  });
});

describe('commitRuntimeAuthRecoveryDiagnosticForDaemon', () => {
  it('forwards the durable attempt and transition identity through the production commit adapter', async () => {
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    try {
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess-runtime-auth-composition',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            encryptionMode: 'plain',
            metadata: '{}',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            dataEncryptionKey: null,
          },
        },
      });
      const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
        status: 200,
        data: {
          didWrite: true,
          message: { id: 'msg-runtime-auth-composition', seq: 2, localId: 'local', createdAt: 2 },
        },
      });

      await commitRuntimeAuthRecoveryDiagnosticForDaemon({
        credentials: {
          token: 'token-runtime-auth-composition',
          encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
        },
        delivery: {
          sessionId: 'sess-runtime-auth-composition',
          attemptId: 'runtime-auth-attempt:composition-1',
          transition: 'working',
          transcriptEvent: {
            type: 'connected-service-runtime-auth-recovery',
            status: 'retry_scheduled',
            serviceId: 'openai-codex',
            groupId: 'team',
            profileId: 'primary',
            attempt: 1,
            nextRetryAtMs: null,
            terminal: false,
            reason: 'runtime_auth_failure',
            diagnostic: {
              code: 'recovery_retry_scheduled',
              failurePhase: 'runtime_auth_recovery',
              source: 'runtime_auth_recovery',
              serviceId: 'openai-codex',
              groupId: 'team',
              profileId: 'primary',
              retryable: true,
              suggestedActions: ['retry'],
            },
          },
        },
      });

      expect(postSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/sessions\/sess-runtime-auth-composition\/messages$/),
        expect.objectContaining({
          localId: buildRuntimeAuthRecoveryAttemptTransitionLocalId({
            attemptId: 'runtime-auth-attempt:composition-1',
            transition: 'working',
          }),
        }),
        expect.anything(),
      );
    } finally {
      if (previousServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServerUrl;
      vi.restoreAllMocks();
    }
  });
});
