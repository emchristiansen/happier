import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import {
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from './selectConnectedServiceAuthGroupCandidate';

const NOW = 1_000_000;
const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax' });

function member(profileId: string, priority = 1) {
  return { profileId, priority, createdAtMs: priority, enabled: true };
}

function scored(remainingPercent: number): ConnectedServiceAuthGroupMemberRuntimeState {
  return { quotaSnapshot: { capturedAtMs: NOW - 1_000, effectiveRemainingPercent: remainingPercent } };
}

function select(input: Readonly<{
  scores: Record<string, number | null>;
  currentProfileId?: string | null;
  counts?: Record<string, number>;
  uniformSample?: number;
  switchReason?: string;
  degraded?: boolean;
  policyOverride?: Record<string, unknown>;
  states?: Record<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>) {
  const members = Object.keys(input.scores).map((id, index) => member(id, index + 1));
  const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>(
    Object.entries(input.scores)
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .map(([id, score]) => [id, scored(score)]),
  );
  for (const [id, state] of Object.entries(input.states ?? {})) memberStatesByProfileId.set(id, state);
  return selectConnectedServiceAuthGroupCandidate({
    nowMs: NOW,
    quotaFreshnessMs: 300_000,
    activeProfileId: input.currentProfileId ?? null,
    policy: input.policyOverride ? ConnectedServiceAuthGroupPolicyV1Schema.parse({ ...policy, ...input.policyOverride }) : policy,
    members,
    memberStatesByProfileId,
    ...(input.switchReason ? { switchReason: input.switchReason } : {}),
    perSession: {
      reservationCountsByProfileId: new Map(Object.entries(input.counts ?? {})),
      uniformSample: input.uniformSample ?? 0,
      degraded: input.degraded ?? false,
    },
  });
}

describe('per_session_softmax selection', () => {
  it('draws with the offset-odds probabilities and records them', () => {
    const selection = select({ scores: { fresh: 100, half: 50 }, uniformSample: 0.5 });
    const expectedFresh = (100 / 10) ** (1 / 1.5) / ((100 / 10) ** (1 / 1.5) + (50 / 60) ** (1 / 1.5));
    expect(selection.perSessionDecision?.probabilityByProfileId.get('fresh')).toBeCloseTo(expectedFresh, 12);
    expect(selection.selected?.profileId).toBe('fresh');
    expect(select({ scores: { fresh: 100, half: 50 }, uniformSample: 0.99 }).selected?.profileId).toBe('half');
    expect(selection.perSessionDecision).toMatchObject({ temperature: 1.5, offsetPercent: 10, degraded: false });
    expect(selection.perSessionDecision?.selectedProbability).toBeCloseTo(expectedFresh, 12);
  });

  it('excludes only the session\'s own current member, not members other sessions use', () => {
    const selection = select({ scores: { mine: 90, other: 40 }, currentProfileId: 'mine', uniformSample: 0 });
    expect(selection.selected?.profileId).toBe('other');
    expect(selection.excluded).toEqual([{ profileId: 'mine', reason: 'current_active' }]);
  });

  it('counts live reservations as s/(1+k)', () => {
    const selection = select({ scores: { fresh: 100, half: 50 }, counts: { fresh: 1 } });
    expect(selection.perSessionDecision?.probabilityByProfileId.get('fresh')).toBeCloseTo(0.5, 12);
  });

  it('uses temperature and offset from the policy and doubles the temperature when degraded', () => {
    const custom = select({ scores: { a: 100, b: 50 }, policyOverride: { softmaxTemperature: 3, softmaxOffsetPercent: 20 } });
    expect(custom.perSessionDecision).toMatchObject({ temperature: 3, offsetPercent: 20 });
    const degraded = select({ scores: { a: 100, b: 50 }, degraded: true });
    expect(degraded.perSessionDecision).toMatchObject({ temperature: 3, offsetPercent: 10, degraded: true });
  });

  it('prefers the soft-threshold tier and falls back to every scored member', () => {
    expect(select({ scores: { thin: 10, ok: 20 }, uniformSample: 0 }).selected?.profileId).toBe('ok');
    const allThin = select({ scores: { a: 10, b: 5 }, uniformSample: 0 });
    expect(allThin.perSessionDecision?.tier).toBe('all_scored');
  });

  it('does not sample unknown-score members when a known-score member is eligible', () => {
    const selection = select({ scores: { known: 30, unknown: null }, uniformSample: 0.99 });
    expect(selection.selected?.profileId).toBe('known');
  });

  it('samples unknown-score members uniformly only for usage-limit failover reasons', () => {
    const usage = select({ scores: { u1: null, u2: null }, switchReason: 'usage_limit', uniformSample: 0.75 });
    expect(usage.selected?.profileId).toBe('u2');
    expect(usage.perSessionDecision?.unknownScoreFallback).toBe(true);
    expect(select({ scores: { u1: null }, switchReason: 'same_provider_account_exhausted' }).selected?.profileId).toBe('u1');
    const auth = select({ scores: { u1: null }, switchReason: 'auth_expired' });
    expect(auth.selected).toBeNull();
    expect(auth.reason).toBe('no_eligible_members');
    expect(select({ scores: { u1: null } }).selected).toBeNull();
  });

  it('behaves like manual for shared-group callers that supply no per-session input', () => {
    const selection = selectConnectedServiceAuthGroupCandidate({
      nowMs: NOW, quotaFreshnessMs: 300_000, activeProfileId: 'a', policy,
      members: [member('a'), member('b', 2)],
      memberStatesByProfileId: new Map([['a', scored(10)], ['b', scored(90)]]),
    });
    expect(selection.selected).toBeNull();
    expect(selection.reason).toBe('manual_strategy');
  });

  it('keeps hard exclusions ahead of the weighted draw', () => {
    const selection = select({
      scores: { exhausted: 0, disabled: 90, ok: 30 },
      states: { disabled: { ...scored(90), autoDisabledReason: 'model_not_entitled' } },
      uniformSample: 0,
    });
    expect(selection.selected?.profileId).toBe('ok');
  });
});
