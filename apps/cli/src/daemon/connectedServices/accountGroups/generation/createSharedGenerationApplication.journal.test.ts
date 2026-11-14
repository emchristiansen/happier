import { describe, expect, it } from 'vitest';

import {
  buildRuntimeAuthAttemptTransitionEvent,
  foldRuntimeAuthAttemptAccountJoins,
  RuntimeAuthAttemptAccountJoinEventSchema,
  type GroupGenerationAppliedEvent,
} from '../../runtimeAuth/runtimeAuthAttemptAccountJoin';
import { createSharedGenerationApplication } from './createSharedGenerationApplication';

const REVISION = 'rev-1' as never;
type Apply = ReturnType<typeof createSharedGenerationApplication>;

function sharedApplication(options: Readonly<{
  descriptorResult?: () => Promise<unknown>;
  held?: boolean;
  /** Successive nowMs readings: hold admission, then rewrite start, then return. */
  clock: number[];
  recorded: GroupGenerationAppliedEvent[];
}>): Apply {
  return createSharedGenerationApplication({
    activeServerDir: '/nonexistent/private',
    resolveDescriptor: async () => ({
      applySharedGenerationApplication: async () => await (options.descriptorResult?.()
        ?? Promise.resolve({ status: 'verified', source: 'claude_shared_group_auth_surface', credentialRevision: REVISION })) as never,
    }),
    resolveTargetCredential: async () => ({ credentialRevision: REVISION, record: {} as never }),
    validateCurrentness: async () => ({ current: true }) as never,
    readMemberHolds: async () => ({
      status: 'readable',
      holdsByProfileId: new Map(options.held
        ? [['holdmod-like', { serviceId: 'claude-subscription', profileId: 'holdmod-like', reason: 'r', source: 's', heldAtMs: 0, lifetime: { kind: 'until_released' } }]]
        : []),
    }) as never,
    nowMs: () => options.clock.shift() ?? 9_999,
    recordGroupGenerationApplied: (event) => { options.recorded.push(event); },
  });
}

const input = (generation: number) => ({
  representativeSessionId: 'search',
  applicationOwnerId: 'claude',
  switchReason: 'usage_limit',
  executionAuthority: 'runtime_recovery',
  committedGeneration: {
    decisionCommittedTarget: { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'holdmod-like', generation },
  },
}) as unknown as Parameters<Apply>[0];

describe('shared generation application journals every surface rewrite it attempts', () => {
  it('records a verified application that then closes another session\'s earlier application in the join', async () => {
    const recorded: GroupGenerationAppliedEvent[] = [];
    await sharedApplication({ clock: [1_990, 2_000, 2_010], recorded })(input(74));
    expect(recorded).toEqual([{
      v: 1, kind: 'group_generation_applied', sessionId: 'search', serviceId: 'claude-subscription', groupId: 'pool',
      generation: 74, profileId: 'holdmod-like', startedAtMs: 2_000, outcome: 'verified', persistedAtMs: 2_010,
    }]);
    // Producer row through the real journal schema and fold: a Matrix application of g73 is closed.
    const parsed = RuntimeAuthAttemptAccountJoinEventSchema.parse(JSON.parse(JSON.stringify(recorded[0])));
    const transition = (persistedAtMs: number, status: string, target: string | null) => buildRuntimeAuthAttemptTransitionEvent({
      attemptId: 'a73', transition: 'working', persistedAtMs,
      intent: {
        sessionId: 'matrix', serviceId: 'claude-subscription', groupId: 'pool', profileId: null, status, attemptCount: 0,
        pendingTargetProfileId: target, pendingTargetGeneration: target ? 73 : null, terminalReason: null,
        classification: { kind: 'usage_limit', sourceKey: null, runtimeIssueFingerprint: 'fp' },
      },
    });
    const [join] = foldRuntimeAuthAttemptAccountJoins([
      transition(1_000, 'waiting', null), transition(1_010, 'resumed_awaiting_proof', 'sothmod-like'), parsed,
      {
        v: 1, kind: 'provider_account_observed', sessionId: 'matrix', serviceId: 'claude-subscription', groupId: 'pool',
        nativeSessionId: 'native-matrix', providerOrganizationId: 'org-h', resolution: { kind: 'unique_member', profileId: 'holdmod-like' },
        adoption: 'adopted', observedAtMs: 3_000,
      },
    ]);
    expect(join!.observations.map((entry) => entry.disposition)).toEqual(['superseded_by_shared_generation']);
    expect(join!.verdict).toBe('applied_awaiting_observation');
  });

  it('records an unavailable or unverified rewrite as such, and nothing for a refused (held) target', async () => {
    const recorded: GroupGenerationAppliedEvent[] = [];
    await sharedApplication({ clock: [0, 1, 2], recorded, descriptorResult: async () => { throw new Error('boom'); } })(input(75));
    await sharedApplication({ clock: [0, 3, 4], recorded, descriptorResult: async () => ({ status: 'unverified' }) })(input(76));
    await sharedApplication({ clock: [5], recorded, held: true })(input(77));
    expect(recorded.map((event) => [event.generation, event.outcome])).toEqual([[75, 'unavailable'], [76, 'unverified']]);
  });
});
