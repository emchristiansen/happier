import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceAuthGroupGenerations,
  reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
  type ConnectedServiceGenerationRuntimeTarget,
} from './reconcileConnectedServiceAuthGroupGenerations';

const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const revisionedCredentialBoundary = () => ({
  status: 'present' as const,
  revisionSemantics: 'revisioned' as const,
  credentialRevision,
});

function group(input: Readonly<{ generation?: number; activeProfileId?: string | null }> = {}): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    activeProfileId: input.activeProfileId === undefined ? 'backup' : input.activeProfileId,
    generation: input.generation ?? 2,
    runtimeStateRevision: 0,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' },
    state: { status: 'ready' },
    createdAt: 1,
    updatedAt: 1,
    members: [],
  };
}

function groupTarget(sessionId = 'live'): ConnectedServiceGenerationRuntimeTarget {
  return {
    sessionId,
    agentId: 'codex',
    activeBindings: [{
      serviceId: 'openai-codex',
      profileId: 'old',
      groupId: 'team',
      generation: 1,
      credentialRevision: 'csr_oldoldoldoldoldoldoldold',
    }],
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
      },
    },
  };
}

type ConsumerDeps = ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0];

function createConsumer(applyCommittedGeneration?: ConsumerDeps['applyCommittedGeneration']) {
  const apply = applyCommittedGeneration ?? vi.fn(async (
    input: Parameters<ConsumerDeps['applyCommittedGeneration']>[0],
  ) => ({
    reconciliationDisposition: 'converged' as const,
    errorCode: null,
    providerAdoptedTarget: {
      ...input.committedGeneration.decisionCommittedTarget,
      proof: {
        status: 'verified' as const,
        source: 'codex_app_server',
        credentialRevision: input.committedGeneration.decisionCommittedTarget.credentialRevision,
      },
    },
  }));
  return {
    consumer: new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration: apply,
      resolveGenerationApplicationScope: async (input) => ({
        status: 'supported',
        scope: 'per_session_runtime',
        ownerId: `test:${input.sessionId}`,
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth: async () => ({ ok: true }),
    }),
    applyCommittedGeneration: vi.mocked(apply),
  };
}

describe('reconcileConnectedServiceAuthGroupGenerations', () => {
  it('does not dispatch a frozen runtime target that is replaced while group truth is loading', async () => {
    const target = groupTarget('same-session');
    let isCurrent = true;
    const { consumer, applyCommittedGeneration } = createConsumer();

    await expect(reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => {
        isCurrent = false;
        return [group()];
      },
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => [target],
      isCurrentRuntimeTarget: (candidate) => candidate === target && isCurrent,
      executionAuthority: 'passive_projection',
    })).resolves.toMatchObject({
      acknowledgeable: true,
      reconciledGroupCount: 0,
      sessionDispositionCount: 0,
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('applies direct credential revisions only to currently registered runtime bindings', async () => {
    const applyLiveCredentialBoundary = vi.fn(async () => {});
    const result = await reconcileConnectedServiceDirectCredentialRevisions({
      credentialBoundaries: [{
        serviceId: 'openai-codex',
        profileId: 'direct',
        boundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision,
        },
      }],
      listRuntimeTargets: () => [{
        sessionId: 'live',
        activeBindings: [],
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
          },
        },
      }],
      applyLiveCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyLiveCredentialBoundary).toHaveBeenCalledOnce();
    expect(result).toEqual({ acknowledgeable: true, appliedBindingCount: 1 });
  });

  it('does not apply or count a direct binding replaced immediately before the live effect', async () => {
    let currentChecks = 0;
    const target: ConnectedServiceGenerationRuntimeTarget = {
      sessionId: 'replaced-direct',
      activeBindings: [],
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
        },
      },
    };
    const applyLiveCredentialBoundary = vi.fn(async () => {});

    const result = await reconcileConnectedServiceDirectCredentialRevisions({
      credentialBoundaries: [{
        serviceId: 'openai-codex',
        profileId: 'direct',
        boundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision,
        },
      }],
      listRuntimeTargets: () => [target],
      isCurrentRuntimeTarget: (candidate) => candidate === target && ++currentChecks < 3,
      applyLiveCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyLiveCredentialBoundary).not.toHaveBeenCalled();
    expect(result).toEqual({ acknowledgeable: true, appliedBindingCount: 0 });
  });

  it('propagates a live direct-credential failure so projection cursor retry remains authoritative', async () => {
    await expect(reconcileConnectedServiceDirectCredentialRevisions({
      credentialBoundaries: [{
        serviceId: 'openai-codex',
        profileId: 'direct',
        boundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision,
        },
      }],
      listRuntimeTargets: () => [{
        sessionId: 'live',
        activeBindings: [],
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
          },
        },
      }],
      applyLiveCredentialBoundary: async () => { throw new Error('temporary provider failure'); },
      executionAuthority: 'passive_projection',
    })).rejects.toThrow('temporary provider failure');
  });

  it('passively applies current direct truth when one late runtime target registers', async () => {
    const applyLiveCredentialBoundary = vi.fn(async () => {});
    const result = await reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
      target: {
        sessionId: 'late',
        activeBindings: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          groupId: null,
          generation: null,
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }],
        connectedServicesBindingsRaw: {},
      },
      resolveCredentialBoundary: () => ({
        status: 'present',
        revisionSemantics: 'revisioned',
        credentialRevision,
      }),
      applyLiveCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(result).toEqual({ appliedBindingCount: 1 });
    expect(applyLiveCredentialBoundary).toHaveBeenCalledWith(expect.objectContaining({
      credentialBoundary: expect.objectContaining({ credentialRevision }),
    }));
  });

  it('applies authoritative absence when one late runtime target still holds the deleted direct credential', async () => {
    const applyLiveCredentialBoundary = vi.fn(async () => {});
    const result = await reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
      target: {
        sessionId: 'late-deleted',
        activeBindings: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          groupId: null,
          generation: null,
          credentialRevision,
        }],
        connectedServicesBindingsRaw: {},
      },
      resolveCredentialBoundary: () => ({ status: 'absent' }),
      applyLiveCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(result).toEqual({ appliedBindingCount: 1 });
    expect(applyLiveCredentialBoundary).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'direct',
      credentialBoundary: { status: 'absent' },
    }));
  });

  it('keeps a present legacy-unfenced credential usable during late runtime reconciliation', async () => {
    const applyLiveCredentialBoundary = vi.fn(async () => {});
    const result = await reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
      target: {
        sessionId: 'late-legacy',
        activeBindings: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          groupId: null,
          generation: null,
          credentialRevision,
        }],
        connectedServicesBindingsRaw: {},
      },
      resolveCredentialBoundary: () => ({
        status: 'present',
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
      }),
      applyLiveCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(result).toEqual({ appliedBindingCount: 0 });
    expect(applyLiveCredentialBoundary).not.toHaveBeenCalled();
  });

  it('does not enumerate or apply offline shared surfaces during projection reconciliation', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    const result = await reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => [],
      executionAuthority: 'passive_projection',
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(result).toEqual({ acknowledgeable: true, reconciledGroupCount: 0, sessionDispositionCount: 0 });
  });

  it('applies one live group and rejects acknowledgement when the live application fails', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'failed' as const,
      errorCode: 'provider_temporarily_unavailable',
    }));
    const { consumer } = createConsumer(applyCommittedGeneration);

    await expect(reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => [groupTarget()],
      executionAuthority: 'passive_projection',
    })).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
  });

  it.each([
    ['deleted group', [], 'group_missing'],
    ['null active profile', [group({ activeProfileId: null })], 'active_profile_missing'],
  ] as const)('fans authoritative %s truth to every live Claude producer without repeating shared materialization', async (
    _label,
    currentGroups,
    unavailableReason,
  ) => {
    const applySharedGenerationApplication = vi.fn(async (
      input: Parameters<NonNullable<ConsumerDeps['applySharedGenerationApplication']>>[0],
    ) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget: {
        ...input.committedGeneration.decisionCommittedTarget,
        proof: {
          status: 'verified' as const,
          source: 'claude_shared_group_auth_surface',
          credentialRevision: input.committedGeneration.decisionCommittedTarget.credentialRevision,
        },
      },
    }));
    const notifyCurrentGroupTruth = vi.fn(async () => ({ ok: true as const }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration: vi.fn(async () => ({
        reconciliationDisposition: 'failed' as const,
        errorCode: 'per_session_apply_must_not_run',
      })),
      applySharedGenerationApplication,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'claude',
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth,
    });
    const targets = ['claude-a', 'claude-b', 'claude-c'].map((sessionId) => ({
      ...groupTarget(sessionId),
      agentId: 'claude',
    }));

    await reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => targets,
      executionAuthority: 'passive_projection',
    });
    expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
    expect(notifyCurrentGroupTruth).toHaveBeenCalledTimes(3);
    notifyCurrentGroupTruth.mockClear();

    const result = await reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => currentGroups,
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => targets,
      executionAuthority: 'passive_projection',
    });

    expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
    expect(notifyCurrentGroupTruth).toHaveBeenCalledTimes(3);
    expect(notifyCurrentGroupTruth).toHaveBeenCalledWith(expect.objectContaining({
      currentTruth: {
        kind: 'current_auth_group_unavailable',
        groupId: 'team',
        unavailableReason,
      },
    }));
    expect(result).toEqual({ acknowledgeable: true, reconciledGroupCount: 1, sessionDispositionCount: 3 });
  });

  it('catches up a temporarily disconnected group only when the runtime re-registers', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await reconcileConnectedServiceAuthGroupGenerations({
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      listRuntimeTargets: () => [],
      executionAuthority: 'passive_projection',
    });
    expect(applyCommittedGeneration).not.toHaveBeenCalled();

    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: groupTarget('re-registered'),
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
  });

  it('clears an unavailable fence when the restored group already has exact provider-adoption proof', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
    }));
    const notifyCurrentGroupTruth = vi.fn(async () => ({ ok: true as const }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'per_session_runtime',
        ownerId: 'codex',
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth,
    });
    const target = {
      ...groupTarget('restored'),
      connectedServiceMaterializationIdentityV1: { id: 'csm_restored' },
    };

    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target,
      consumer,
      listCurrentGroups: async () => [],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });
    notifyCurrentGroupTruth.mockClear();

    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target,
      providerAdoptedTargets: [{
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        generation: 2,
        credentialRevision,
        proof: {
          status: 'verified',
          source: 'codex_app_server',
          credentialRevision,
        },
      }],
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(notifyCurrentGroupTruth).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'restored',
      currentTruth: {
        kind: 'current_auth_group_available',
        groupId: 'team',
        generation: 2,
        credentialRevision,
      },
    }));
  });

  it('skips late registration replay only with exact fresh provider proof', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: groupTarget('late'),
      providerAdoptedTargets: [{
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        generation: 2,
        credentialRevision,
        proof: {
          status: 'verified',
          source: 'codex_app_server',
          credentialRevision,
        },
      }],
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('acknowledges an exact successfully materialized spawn target without calling the not-yet-ready runtime again', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    const notifyCurrentGroupTruth = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'runtime_not_ready_for_current_truth_callback',
    }));
    const applicationConsumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'per_session_runtime',
        ownerId: 'codex',
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth,
    });

    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('fresh-spawn'),
        connectedServiceMaterializationIdentityV1: { id: 'csm_fresh_spawn' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision,
        }],
      },
      consumer: applicationConsumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(notifyCurrentGroupTruth).not.toHaveBeenCalled();
  });

  it('acknowledges an exact successfully materialized supported legacy credential', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();

    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('legacy-spawn'),
        connectedServiceMaterializationIdentityV1: { id: 'csm_legacy_spawn' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision: null,
        }],
      },
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => null,
      resolveCredentialBoundary: () => ({
        status: 'present',
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
      }),
      executionAuthority: 'passive_projection',
    })).resolves.toEqual({
      acknowledgeable: true,
      reconciledGroupCount: 1,
      sessionDispositionCount: 0,
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('keeps exact spawn settlement when provider verification also observes the legacy shared surface', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();

    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('legacy-spawn-with-provider-proof'),
        connectedServiceMaterializationIdentityV1: { id: 'csm_legacy_spawn_with_provider_proof' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision: null,
        }],
      },
      providerAdoptedTargets: [{
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup',
        generation: 2,
        credentialRevision: null,
        proof: {
          status: 'verified',
          source: 'shared_surface',
          sharedAuthSurfaceId: 'team',
          credentialRevision: null,
          credentialFingerprint: 'sha256:legacy-current',
        },
      }],
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => null,
      resolveCredentialBoundary: () => ({
        status: 'present',
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
      }),
      executionAuthority: 'passive_projection',
    })).resolves.toEqual({
      acknowledgeable: true,
      reconciledGroupCount: 1,
      sessionDispositionCount: 0,
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('does not treat a missing credential as a successfully materialized legacy credential', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();

    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('missing-credential-spawn'),
        connectedServiceMaterializationIdentityV1: { id: 'csm_missing_credential_spawn' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision: null,
        }],
      },
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => null,
      resolveCredentialBoundary: () => ({ status: 'absent' }),
      executionAuthority: 'passive_projection',
    })).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
  });

  it('still reconciles a materialized target whose credential revision is stale', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();

    await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('stale-spawn'),
        connectedServiceMaterializationIdentityV1: { id: 'csm_stale_spawn' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision: 'csr_oldoldoldoldoldoldoldold',
        }],
      },
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    });

    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({ credentialRevision }),
      }),
    }));
  });

  it('does not treat spawn materialization as target-local settlement for a request-time broker runtime', async () => {
    const { applyCommittedGeneration } = createConsumer();
    const notifyCurrentGroupTruth = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'broker_current_truth_not_applied',
    }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'broker',
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth,
    });

    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        ...groupTarget('broker-spawn'),
        brokerSelectionIdentity: 'broker-selection',
        connectedServiceMaterializationIdentityV1: { id: 'csm_broker_spawn' },
        activeBindings: [{
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
          generation: 2,
          credentialRevision,
        }],
      },
      consumer,
      listCurrentGroups: async () => [group()],
      resolveCredentialRevision: () => credentialRevision,
      resolveCredentialBoundary: revisionedCredentialBoundary,
      executionAuthority: 'passive_projection',
    })).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(notifyCurrentGroupTruth).toHaveBeenCalledOnce();
  });
});
