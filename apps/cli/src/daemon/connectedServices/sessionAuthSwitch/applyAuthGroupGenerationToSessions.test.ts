import { NO_CONNECTED_SERVICE_MEMBER_HOLDS } from '../accountGroups/holds/connectedServiceMemberHolds';
import { describe, expect, it, vi } from 'vitest';

import { applyConnectedServiceAuthGroupGenerationToSessions } from './applyAuthGroupGenerationToSessions';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
} from './connectedServiceAuthSwitchOutcome';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { mapCommittedGenerationApplyResult } from '../accountGroups/generation/mapCommittedGenerationApplyResult';

const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';

function converged(fact: ConnectedServiceAuthGroupCommittedGenerationFact) {
  return {
    reconciliationDisposition: 'converged' as const,
    errorCode: null,
    providerAdoptedTarget: {
      ...fact.decisionCommittedTarget,
      proof: {
        status: 'verified' as const,
        source: 'test_verification',
        credentialRevision: fact.decisionCommittedTarget.credentialRevision,
      },
    },
  };
}

function deferred() {
  type Result = ReturnType<typeof converged>;
  let resolve: (value: Result) => void = () => {};
  const promise = new Promise<Result>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function sharedVerificationDeps() {
  return {
    verifySharedGenerationApplication: async () => null,
  };
}

describe('applyConnectedServiceAuthGroupGenerationToSessions', () => {
  const manualGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
    decisionId: 'manual-7',
    provenance: 'manual',
    decisionCommittedTarget: {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'next',
      generation: 7,
      credentialRevision,
    },
  });

  it('accepts one immutable committed generation and reports every non-converged live recipient', async () => {
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-once',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 2,
        credentialRevision,
      },
    });
    const selectionCalls: string[] = [];
    const applied: string[] = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: Array.from({ length: 5 }, (_, index) => ({
        sessionId: `session-${index}`,
        fromProfileId: 'source',
      })),
      applyCommittedGeneration: async ({ sessionId, committedGeneration: exactFact }) => {
        applied.push(`${sessionId}:${exactFact.decisionId}:${exactFact.decisionCommittedTarget.generation}`);
        return sessionId === 'session-4'
          ? { reconciliationDisposition: 'deferred_restart' as const, errorCode: null }
          : converged(exactFact);
      },
    });

    // There is deliberately no selector/committer callback in the recipient API.
    expect(selectionCalls).toEqual([]);
    expect(applied).toHaveLength(5);
    expect(new Set(applied.map((value) => value.split(':').slice(1).join(':')))).toEqual(
      new Set(['decision-once:2']),
    );
    expect(result.resultsBySessionId?.['session-4']).toMatchObject({
      reconciliationDisposition: 'deferred_restart',
    });
    expect(result).toMatchObject({
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 1,
    });
  });

  it('reports a live deferred application truthfully without requiring pending persistence', async () => {
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-persist-failure',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 3,
        credentialRevision,
      },
    });
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async () => ({
        reconciliationDisposition: 'deferred_restart',
        errorCode: null,
      }),
    });

    expect(result.resultsBySessionId?.['session-1']).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: null,
    });
    expect(result.failures).toEqual([]);
  });

  it('boundedly redistributes the authoritative generation when B is superseded by C during apply', async () => {
    const generationB = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup-b',
        generation: 2,
        credentialRevision,
      },
    });
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-c',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup-c',
        generation: 3,
        credentialRevision,
      },
    });
    const applied: string[] = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: generationB,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [
        { sessionId: 'session-1', fromProfileId: 'source' },
        { sessionId: 'session-2', fromProfileId: 'source' },
      ],
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        applied.push(`${sessionId}:${committedGeneration.decisionCommittedTarget.generation}`);
        if (sessionId === 'session-1' && committedGeneration.decisionCommittedTarget.generation === 2) {
          return {
            reconciliationDisposition: 'superseded_after_apply',
            errorCode: null,
            authoritativeGeneration: generationC,
          };
        }
        return converged(committedGeneration);
      },
    });

    expect(applied).toEqual(expect.arrayContaining([
      'session-1:2',
      'session-2:2',
      'session-1:3',
      'session-2:3',
    ]));
    expect(result.appliedSessionCount).toBe(2);
    expect(result.failedSessionCount).toBe(0);
  });

  it('re-applies C when its projection already advanced the cursor before the real B apply observes supersession', async () => {
    const generationB = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b-after-projection-c',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex', groupId: 'team', profileId: 'backup-b', generation: 2, credentialRevision,
      },
    });
    const authoritativeState = {
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'backup-c',
      generation: 3,
      runtimeStateRevision: 0,
      credentialRevision,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' as const },
      members: [],
      memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS, memberStatesByProfileId: new Map(),
    };
    const runtimeEpochs: string[] = ['backup-c:3'];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => authoritativeState,
      commitSwitch: async () => authoritativeState,
      applyGeneration: async ({ activeProfileId, generation, credentialRevision: appliedRevision }) => {
        if (activeProfileId === null || appliedRevision == null) {
          throw new Error('Exact generation application fixture requires a complete auth epoch');
        }
        runtimeEpochs.push(`${activeProfileId}:${generation}`);
        return {
          mode: 'hot_apply' as const,
          verificationByServiceId: {
            'openai-codex': {
              status: 'verified' as const,
              proofStrength: 'exact' as const,
              providerAccountId: activeProfileId,
              generationApplication: {
                serviceId: 'openai-codex' as const,
                groupId: 'team',
                profileId: activeProfileId,
                generation,
                credentialRevision: appliedRevision,
                credentialFingerprint: `${activeProfileId}:${generation}`,
              },
            },
          },
        };
      },
    });

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: generationB,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => mapCommittedGenerationApplyResult({
        committedGeneration,
        result: await coordinator.applyCommittedGeneration({
          sessionId,
          ...committedGeneration.decisionCommittedTarget,
          activeProfileId: committedGeneration.decisionCommittedTarget.profileId,
          reason: committedGeneration.provenance,
        }),
      }),
    });

    // C was already projected and acknowledged before this call. The real coordinator applies stale
    // B, then reloads server C and reports supersession; no later projection edge is guaranteed.
    expect(runtimeEpochs).toEqual(['backup-c:3', 'backup-b:2', 'backup-c:3']);
    expect(result).toMatchObject({ ok: true, appliedSessionCount: 1, failedSessionCount: 0 });
  });

  it('redistributes an authoritative revision-only epoch at the same group generation', async () => {
    const initial = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'revision-a',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'work',
        generation: 2,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const authoritative = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'revision-b',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'work',
        generation: 2,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    const appliedRevisions: Array<string | null> = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: initial,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'work' }],
      applyCommittedGeneration: async ({ committedGeneration }) => {
        const revision = committedGeneration.decisionCommittedTarget.credentialRevision;
        appliedRevisions.push(revision);
        return revision === initial.decisionCommittedTarget.credentialRevision
          ? { reconciliationDisposition: 'superseded_after_apply', errorCode: null, authoritativeGeneration: authoritative }
          : converged(committedGeneration);
      },
    });

    expect(appliedRevisions).toEqual([
      'csr_aaaaaaaaaaaaaaaaaaaaaa',
      'csr_bbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(result.failedSessionCount).toBe(0);
  });

  it('keeps shared provider owners and per-session runtimes as distinct application effects', async () => {
    const perSessionApplied: string[] = [];
    const sharedApplied: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'claude-a', fromProfileId: 'old-a', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'claude' },
        { sessionId: 'claude-b', fromProfileId: 'old-b', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'claude' },
        { sessionId: 'other-a', fromProfileId: 'old', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'other-provider' },
        { sessionId: 'direct-a', fromProfileId: 'direct-old', applicationScope: 'per_session_runtime', applicationOwnerId: 'direct-a' },
      ],
      applySharedGenerationApplication: async ({ applicationOwnerId }) => {
        sharedApplied.push(applicationOwnerId);
        return converged(manualGeneration);
      },
      applyCommittedGeneration: async ({ sessionId }) => {
        perSessionApplied.push(sessionId);
        return converged(manualGeneration);
      },
    });

    expect(sharedApplied).toEqual(['claude', 'other-provider']);
    expect(perSessionApplied).toEqual(['direct-a']);
    expect(result.appliedSessionCount).toBe(4);
  });

  it('settles every exact shared recipient after one provider effect, including verification-only convergence', async () => {
    const applied = vi.fn(async () => converged(manualGeneration));
    const settled: string[] = [];
    const input = {
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure' as const,
      executionAuthority: 'runtime_recovery' as const,
      targets: ['origin-a', 'origin-b', 'unrelated'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applySharedGenerationApplication: applied,
      applyCommittedGeneration: vi.fn(async () => converged(manualGeneration)),
      settleExactRecipientApplication: async ({ sessionId }: { sessionId: string }) => {
        if (sessionId !== 'unrelated') settled.push(sessionId);
      },
    };

    await expect(applyConnectedServiceAuthGroupGenerationToSessions(input)).resolves.toMatchObject({
      ok: true,
      appliedSessionCount: 3,
    });
    expect(applied).toHaveBeenCalledOnce();
    expect(settled).toEqual(['origin-a', 'origin-b']);

    applied.mockClear();
    settled.length = 0;
    const exactProof = converged(manualGeneration).providerAdoptedTarget;
    await expect(applyConnectedServiceAuthGroupGenerationToSessions({
      ...input,
      verifySharedGenerationApplication: async () => exactProof,
    })).resolves.toMatchObject({ ok: true, appliedSessionCount: 3 });
    expect(applied).not.toHaveBeenCalled();
    expect(settled).toEqual(['origin-a', 'origin-b']);
  });

  it('reports one shared representative failure for every bound session without another provider apply', async () => {
    const applySharedGenerationApplication = vi.fn(async () => ({
      reconciliationDisposition: 'failed' as const,
      errorCode: 'provider_application_failed',
    }));
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['a', 'b', 'c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applySharedGenerationApplication,
      applyCommittedGeneration: vi.fn(async () => converged(manualGeneration)),
    });

    expect(applySharedGenerationApplication).toHaveBeenCalledTimes(1);
    expect(result.failedSessionCount).toBe(3);
    expect(result.resultsBySessionId?.b).toMatchObject({
      reconciliationDisposition: 'failed',
      errorCode: 'provider_application_failed',
    });
  });

  it('re-enters one shared provider application per superseding epoch and projects the final proof N times', async () => {
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'shared-c',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        ...manualGeneration.decisionCommittedTarget,
        profileId: 'final',
        generation: 8,
      },
    });
    const appliedGenerations: number[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['a', 'b', 'c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applySharedGenerationApplication: async ({ committedGeneration }) => {
        appliedGenerations.push(committedGeneration.decisionCommittedTarget.generation);
        return committedGeneration.decisionCommittedTarget.generation === 7
          ? { reconciliationDisposition: 'superseded_after_apply' as const, errorCode: null, authoritativeGeneration: generationC }
          : converged(committedGeneration);
      },
      applyCommittedGeneration: vi.fn(async () => converged(manualGeneration)),
    });

    expect(appliedGenerations).toEqual([7, 8]);
    expect(result.appliedSessionCount).toBe(3);
  });

  it('recovers a lost shared-effect response through exact provider verification without receipt I/O or a duplicate effect', async () => {
    let providerTarget: ReturnType<typeof converged>['providerAdoptedTarget'] | null = null;
    const providerEffects: ConnectedServiceAuthGroupCommittedGenerationFact[] = [];
    const applySharedGenerationApplication = vi.fn(async ({ committedGeneration }: Readonly<{
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    }>) => {
      providerEffects.push(committedGeneration);
      providerTarget = converged(committedGeneration).providerAdoptedTarget;
      throw new Error('provider response lost after effect');
    });
    const verifySharedGenerationApplication = vi.fn(async ({
      committedGeneration,
      applicationOwnerId,
    }: Readonly<{
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      applicationOwnerId: string;
    }>) => {
      expect(applicationOwnerId).toBe('claude');
      expect(committedGeneration.decisionCommittedTarget).toEqual({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 7,
        credentialRevision,
      });
      return providerTarget;
    });
    const input = {
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure' as const,
      executionAuthority: 'runtime_recovery' as const,
      targets: ['a', 'b'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      verifySharedGenerationApplication,
      applySharedGenerationApplication,
      applyCommittedGeneration: vi.fn(async () => converged(manualGeneration)),
    };

    const lostResponse = await applyConnectedServiceAuthGroupGenerationToSessions(input);
    expect(lostResponse.failedSessionCount).toBe(2);

    const recovered = await applyConnectedServiceAuthGroupGenerationToSessions(input);

    expect(providerEffects).toEqual([manualGeneration]);
    expect(applySharedGenerationApplication).toHaveBeenCalledTimes(1);
    expect(verifySharedGenerationApplication).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      ok: true,
      appliedSessionCount: 2,
      failedSessionCount: 0,
    });
  });

  it('single-flights concurrent duplicate deliveries for the same exact shared epoch', async () => {
    const gate = deferred();
    const applySharedGenerationApplication = vi.fn(async () => await gate.promise);
    const verifySharedGenerationApplication = vi.fn(async () => null);
    const buildInput = (sessionId: string) => ({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure' as const,
      executionAuthority: 'runtime_recovery' as const,
      targets: [{
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      }],
      verifySharedGenerationApplication,
      applySharedGenerationApplication,
      applyCommittedGeneration: vi.fn(async () => converged(manualGeneration)),
    });

    const first = applyConnectedServiceAuthGroupGenerationToSessions(buildInput('a'));
    const second = applyConnectedServiceAuthGroupGenerationToSessions(buildInput('b'));
    await vi.waitFor(() => expect(applySharedGenerationApplication).toHaveBeenCalledTimes(1));
    gate.resolve(converged(manualGeneration));
    const results = await Promise.all([first, second]);

    expect(verifySharedGenerationApplication).toHaveBeenCalledTimes(1);
    expect(applySharedGenerationApplication).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.appliedSessionCount)).toEqual([1, 1]);
  });

  it('does not start a shared provider apply when its exact runtime registration is replaced during proof', async () => {
    let isCurrent = true;
    let resolveProof!: (value: null) => void;
    const proof = new Promise<null>((resolve) => {
      resolveProof = resolve;
    });
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));
    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'passive_projection',
      targets: [{
        sessionId: 'same-session',
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'claude',
        isCurrent: () => isCurrent,
      }],
      verifySharedGenerationApplication: async () => await proof,
      applyCommittedGeneration,
    });

    await Promise.resolve();
    isCurrent = false;
    resolveProof(null);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      appliedSessionCount: 0,
      failedSessionCount: 0,
      resultsBySessionId: {},
    });
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('fails shared scopes before provider mechanics when exact verification wiring is absent', async () => {
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{
        sessionId: 'a',
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'claude',
      }],
      applyCommittedGeneration,
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(result.resultsBySessionId?.a).toMatchObject({
      reconciliationDisposition: 'failed',
      errorCode: 'shared_application_verification_wiring_missing',
    });
  });

  it('reports the authoritative epoch truthfully when redistribution reaches its bound', async () => {
    const initial = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-1',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-1',
        generation: 1,
        credentialRevision,
      },
    });

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: initial,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async ({ committedGeneration }) => {
        const generation = committedGeneration.decisionCommittedTarget.generation + 1;
        return {
          reconciliationDisposition: 'superseded_after_apply',
          errorCode: null,
          authoritativeGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
            decisionId: `decision-${generation}`,
            provenance: 'reconciliation',
            decisionCommittedTarget: {
              serviceId: 'openai-codex',
              groupId: 'team',
              profileId: `profile-${generation}`,
              generation,
              credentialRevision,
            },
          }),
        };
      },
    });

    expect(result.resultsBySessionId?.['session-1']).toEqual({
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: 'generation_redistribution_limit_reached',
    });
    expect(result.failures).toEqual([{
      sessionId: 'session-1',
      errorCode: 'generation_redistribution_limit_reached',
    }]);
  });
  it('fans out to sessions in parallel instead of serializing turn-boundary deferrals', async () => {
    // Live incident 2026-07-10: the sequential loop meant N mid-turn sessions cost N × the 60s
    // deferral window, guaranteeing the client ack aborted and the UI reported divergence on every
    // pool switch. Sessions are independent (per-session FSM locks); the fan-out must overlap them.
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'sess_1', fromProfileId: 'prev' },
        { sessionId: 'sess_2', fromProfileId: null },
      ],
      applyCommittedGeneration: async (input) => {
        started.push(input.sessionId);
        return input.sessionId === 'sess_1' ? first.promise : second.promise;
      },
    });

    // Both applies must have STARTED before either resolves — the sequential shape never starts
    // the second until the first settles.
    await Promise.resolve();
    expect(started.sort()).toEqual(['sess_1', 'sess_2']);

    first.resolve(converged(manualGeneration));
    second.resolve(converged(manualGeneration));
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      appliedSessionCount: 2,
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 0,
      failedSessionCount: 0,
      failures: [],
    });
  });

  it('does not start provider apply when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));

    await expect(applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [{ sessionId: 'session-1', fromProfileId: null }],
      applyCommittedGeneration,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
  });

  it('joins an in-flight provider apply and aborts before starting queued work', async () => {
    const controller = new AbortController();
    const apply = deferred();
    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [
        { sessionId: 'session-1', fromProfileId: null },
        { sessionId: 'session-2', fromProfileId: null },
        { sessionId: 'session-3', fromProfileId: null },
        { sessionId: 'session-4', fromProfileId: null },
        { sessionId: 'session-queued', fromProfileId: null },
      ],
      applyCommittedGeneration: vi.fn(async () => await apply.promise),
    });

    await Promise.resolve();
    controller.abort();
    apply.resolve(converged(manualGeneration));

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts when cancellation arrives during provider success', async () => {
    const controller = new AbortController();

    await expect(applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [{
        sessionId: 'session-1',
        fromProfileId: null,
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'shared-owner',
      }],
      applyCommittedGeneration: async () => {
        controller.abort();
        return converged(manualGeneration);
      },
      applySharedGenerationApplication: async () => {
        controller.abort();
        return converged(manualGeneration);
      },
      ...sharedVerificationDeps(),
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('records per-session failures without aborting the other sessions', async () => {
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'sess_ok', fromProfileId: null },
        { sessionId: 'sess_fail', fromProfileId: null },
        { sessionId: 'sess_throw', fromProfileId: null },
      ],
      applyCommittedGeneration: async (input) => {
        if (input.sessionId === 'sess_fail') return { reconciliationDisposition: 'failed', errorCode: 'restart_failed' };
        if (input.sessionId === 'sess_throw') throw new Error('boom');
        return converged(manualGeneration);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.appliedSessionCount).toBe(1);
    expect(result.failedSessionCount).toBe(2);
    expect(result.failures).toEqual(expect.arrayContaining([
      { sessionId: 'sess_fail', errorCode: 'restart_failed' },
      { sessionId: 'sess_throw', errorCode: 'apply_generation_threw' },
    ]));
  });

  it('bounds fan-out concurrency so a large pool cannot thundering-herd restarts', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const targets = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `sess_${index}`,
      fromProfileId: null,
    }));

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets,
      applyCommittedGeneration: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return converged(manualGeneration);
      },
    });

    expect(result.appliedSessionCount).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
