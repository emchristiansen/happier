import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  resolveConnectedServiceAuthGroupQuotaResetCandidates,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
} from '../switching/ConnectedServiceAuthGroupSwitchCoordinator';
import {
  NO_CONNECTED_SERVICE_MEMBER_HOLDS,
  type ConnectedServiceMemberHold,
  type ConnectedServiceMemberHoldView,
} from './connectedServiceMemberHolds';

const NOW = 1_000_000;
const SERVICE = 'claude-subscription';

function holds(entries: Array<[string, ConnectedServiceMemberHold['lifetime']]>): ConnectedServiceMemberHoldView {
  return {
    status: 'readable',
    holdsByProfileId: new Map(entries.map(([profileId, lifetime]) => [profileId, {
      serviceId: SERVICE, profileId, reason: 'seven_day 429 observed', source: 'placement', heldAtMs: NOW - 1, lifetime,
    }])),
  };
}

const members = [
  { profileId: 'A', priority: 1, createdAtMs: 1, enabled: true },
  { profileId: 'B', priority: 2, createdAtMs: 2, enabled: true },
  { profileId: 'C', priority: 3, createdAtMs: 3, enabled: true },
];

function select(memberHolds: ConnectedServiceMemberHoldView, overrides: Partial<Parameters<typeof selectConnectedServiceAuthGroupCandidate>[0]> = {}) {
  return selectConnectedServiceAuthGroupCandidate({
    nowMs: NOW,
    quotaFreshnessMs: 60_000,
    activeProfileId: 'A',
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' },
    members,
    memberStatesByProfileId: new Map(),
    memberHolds,
    ...overrides,
  });
}

describe('hold-aware ordinary group selection', () => {
  it('skips a held member that is otherwise the best eligible candidate', () => {
    const unheld = select(NO_CONNECTED_SERVICE_MEMBER_HOLDS);
    expect(unheld.selected?.profileId).toBe('B');

    const result = select(holds([['B', { kind: 'until', untilMs: NOW + 5_000 }]]));
    expect(result.selected?.profileId).toBe('C');
    expect(result.excluded).toContainEqual({ profileId: 'B', reason: 'held', retryAtMs: NOW + 5_000 });
    expect(result.decisionTrace.candidates.find((entry) => entry.profileId === 'B'))
      .toMatchObject({ decision: 'excluded', exclusionReason: 'held', retryAtMs: NOW + 5_000 });
  });

  it('honors expiry at the decision clock and release by removal', () => {
    const view = holds([['B', { kind: 'until', untilMs: NOW + 5_000 }]]);
    expect(select(view, { nowMs: NOW + 4_999 }).selected?.profileId).toBe('C');
    expect(select(view, { nowMs: NOW + 5_000 }).selected?.profileId).toBe('B');
    // Release removes the hold; the next decision sees no hold.
    expect(select(holds([])).selected?.profileId).toBe('B');
  });

  it('excludes a held active member even when the current member may be retried', () => {
    const result = select(holds([['A', { kind: 'until_released' }]]), { allowCurrentProfileRetry: true });
    expect(result.selected?.profileId).toBe('B');
    expect(result.excluded).toContainEqual({ profileId: 'A', reason: 'held', retryAtMs: null });
  });

  it('terminates truthfully when every member is held', () => {
    const result = select(holds([
      ['A', { kind: 'until_released' }],
      ['B', { kind: 'until', untilMs: NOW + 9_000 }],
      ['C', { kind: 'until', untilMs: NOW + 7_000 }],
    ]), { allowCurrentProfileRetry: true });
    expect(result.selected).toBeNull();
    expect(result.reason).toBe('no_eligible_members');
    expect(result.excluded.map((entry) => [entry.profileId, entry.reason, entry.retryAtMs])).toEqual([
      ['A', 'held', null], ['B', 'held', NOW + 9_000], ['C', 'held', NOW + 7_000],
    ]);
  });

  it('fails closed for every member when hold state is unreadable', () => {
    const result = select({ status: 'unreadable', error: 'invalid member hold file' }, { allowCurrentProfileRetry: true });
    expect(result.selected).toBeNull();
    expect(new Set(result.excluded.map((entry) => entry.reason))).toEqual(new Set(['hold_state_unreadable']));
  });

  it('keeps existing exclusions and never offers a held member a quota reset', () => {
    const exhausted: ConnectedServiceAuthGroupMemberRuntimeState = { quotaSnapshot: {
      capturedAtMs: NOW, effectiveRemainingPercent: 0,
      meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: NOW + 100_000, providerLimitId: 'seven_day' }],
    } };
    const params = {
      nowMs: NOW, quotaFreshnessMs: 60_000, activeProfileId: 'A',
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' as const },
      members,
      memberStatesByProfileId: new Map([['A', exhausted], ['B', exhausted], ['C', exhausted]]),
    };
    expect(resolveConnectedServiceAuthGroupQuotaResetCandidates({ ...params, memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS })
      .map((candidate) => candidate.profileId)).toEqual(['A', 'B', 'C']);
    expect(resolveConnectedServiceAuthGroupQuotaResetCandidates({ ...params, memberHolds: holds([['B', { kind: 'until_released' }]]) })
      .map((candidate) => candidate.profileId)).toEqual(['A', 'C']);
    expect(resolveConnectedServiceAuthGroupQuotaResetCandidates({ ...params, memberHolds: { status: 'unreadable', error: 'x' } }))
      .toEqual([]);
  });
});

describe('hold-aware failover through the switch coordinator', () => {
  function coordinatorFor(memberHolds: ConnectedServiceMemberHoldView, maxSwitchesPerTurn = 1) {
    let current: ConnectedServiceAuthGroupSwitchState = {
      serviceId: SERVICE, groupId: 'g', activeProfileId: 'A', generation: 1, runtimeStateRevision: 0,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true, maxSwitchesPerTurn },
      members, memberStatesByProfileId: new Map(), memberHolds,
    };
    const commits: string[] = [];
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => NOW,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        commits.push(toProfileId);
        current = { ...current, activeProfileId: toProfileId, generation: current.generation + 1 };
        return current;
      },
      applyGeneration: vi.fn(async ({ activeProfileId }) => {
        applied.push(activeProfileId!);
        return { mode: 'hot_apply' as const };
      }),
    });
    return { coordinator, commits, applied };
  }

  it('fails over past a known-held member without spending switch budget on it', async () => {
    const { coordinator, commits, applied } = coordinatorFor(holds([['B', { kind: 'until', untilMs: NOW + 60_000 }]]));
    const result = await coordinator.switchAfterClassifiedFailure({
      serviceId: SERVICE, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit', switchesThisTurn: 0,
    });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'C' });
    // One switch, straight to the eligible member: the held member was never tried.
    expect(commits).toEqual(['C']);
    expect(applied).toEqual(['C']);
  });

  it('without the hold the same failure lands on the held member (regression witness)', async () => {
    const { coordinator, commits } = coordinatorFor(NO_CONNECTED_SERVICE_MEMBER_HOLDS);
    await coordinator.switchAfterClassifiedFailure({
      serviceId: SERVICE, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit', switchesThisTurn: 0,
    });
    expect(commits).toEqual(['B']);
  });

  it('reports no eligible member with the earliest hold expiry when all alternatives are held', async () => {
    const { coordinator, commits, applied } = coordinatorFor(holds([
      ['B', { kind: 'until', untilMs: NOW + 9_000 }],
      ['C', { kind: 'until', untilMs: NOW + 7_000 }],
    ]));
    const result = await coordinator.switchAfterClassifiedFailure({
      serviceId: SERVICE, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit', switchesThisTurn: 0,
    });
    expect(result).toMatchObject({ status: 'no_eligible_member', retryAtMs: NOW + 7_000 });
    expect(result.status === 'no_eligible_member' && result.excluded.filter((entry) => entry.reason === 'held')
      .map((entry) => entry.profileId)).toEqual(['B', 'C']);
    expect(commits).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('reports no retry time when the remaining members are held until released', async () => {
    const { coordinator, commits } = coordinatorFor(holds([['B', { kind: 'until_released' }], ['C', { kind: 'until_released' }]]));
    const result = await coordinator.switchAfterClassifiedFailure({
      serviceId: SERVICE, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit', switchesThisTurn: 0,
    });
    expect(result).toMatchObject({ status: 'no_eligible_member' });
    expect(result.status === 'no_eligible_member' && result.retryAtMs).toBeNull();
    expect(commits).toEqual([]);
  });
});
