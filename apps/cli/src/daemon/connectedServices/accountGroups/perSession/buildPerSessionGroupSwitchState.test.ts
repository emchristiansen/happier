import { describe, expect, it } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { NO_CONNECTED_SERVICE_MEMBER_HOLDS } from '../holds/connectedServiceMemberHolds';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildPerSessionGroupSwitchState } from './buildPerSessionGroupSwitchState';

const member = (profileId: string, priority: number) => ({
  v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'pool', profileId, enabled: true, priority,
  createdAt: priority, updatedAt: priority, state: { credentialHealthStatus: 'connected' as const },
});

function createGroup(): ConnectedServiceAuthGroupV1 {
  return {
    v: 1, serviceId: 'claude-subscription', groupId: 'pool', displayName: 'Pool', activeProfileId: 'failed',
    generation: 3, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 2,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
    members: [member('failed', 1), member('alpha', 2), member('beta', 3)],
  };
}

function createSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'claude', accountSubjectId: `acct_${profileId}`, subjectKind: 'account', quotaScope: 'account',
  };
  return {
    v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'claude',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000, fetchedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly', label: 'Weekly', used: 100 - remainingPct, limit: 100, remaining: remainingPct, remainingPct,
      usedPct: 100 - remainingPct, utilizationPct: 100 - remainingPct, resetsAt: 10_000, resetAtMs: 10_000,
      unit: 'credits', status: 'ok', limitScope: 'account', confidence: 'exact', details: { limitCategory: 'usage_limit' },
    }],
  };
}

const runtimeQuotaSnapshot = (profileId: string) => ({ marker: `runtime:${profileId}` }) as never;

function runtimeStore(profileIds: readonly string[]): ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore {
  return {
    buildMemberStates: () => new Map(profileIds.map((profileId) => [profileId, {
      lastObservedAtMs: 900, quotaSnapshot: runtimeQuotaSnapshot(profileId),
    }])),
  } as unknown as ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
}

const accountUsageFor = (profileIds: readonly string[]) => ({
  resolveBySource: (source: Readonly<{ profileId: string }>) =>
    (profileIds.includes(source.profileId) ? createSnapshot(source.profileId, 0) : null),
});

describe('buildPerSessionGroupSwitchState', () => {
  it('keeps the runtime quota snapshot of members without an account-usage record when another member has one', () => {
    const state = buildPerSessionGroupSwitchState({
      group: createGroup(), nowMs: 1_000, memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS,
      accountUsageStore: accountUsageFor(['failed']),
      runtimeQuotaSnapshots: runtimeStore(['failed', 'alpha', 'beta']),
    });
    // The failed member's account-usage record wins over its runtime snapshot.
    expect(state.memberStatesByProfileId.get('failed')?.quotaSnapshot).not.toEqual(runtimeQuotaSnapshot('failed'));
    expect(state.memberStatesByProfileId.get('failed')?.quotaSnapshot).toBeTruthy();
    // The others keep their runtime scores instead of losing them (T4 failover uniform fallback).
    expect(state.memberStatesByProfileId.get('alpha')?.quotaSnapshot).toEqual(runtimeQuotaSnapshot('alpha'));
    expect(state.memberStatesByProfileId.get('beta')?.quotaSnapshot).toEqual(runtimeQuotaSnapshot('beta'));
  });

  it('uses account usage for every member that has a record', () => {
    const state = buildPerSessionGroupSwitchState({
      group: createGroup(), nowMs: 1_000, memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS,
      accountUsageStore: accountUsageFor(['failed', 'alpha', 'beta']),
      runtimeQuotaSnapshots: runtimeStore(['failed', 'alpha', 'beta']),
    });
    for (const profileId of ['failed', 'alpha', 'beta']) {
      expect(state.memberStatesByProfileId.get(profileId)?.quotaSnapshot).not.toEqual(runtimeQuotaSnapshot(profileId));
      expect(state.memberStatesByProfileId.get(profileId)?.quotaSnapshot).toBeTruthy();
    }
  });

  it('uses runtime snapshots when the account-usage store is cold, and persisted state when neither exists', () => {
    const cold = buildPerSessionGroupSwitchState({
      group: createGroup(), nowMs: 1_000, memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS,
      accountUsageStore: accountUsageFor([]), runtimeQuotaSnapshots: runtimeStore(['alpha']),
    });
    expect(cold.memberStatesByProfileId.get('alpha')?.quotaSnapshot).toEqual(runtimeQuotaSnapshot('alpha'));
    expect(cold.memberStatesByProfileId.get('beta')?.quotaSnapshot ?? null).toBeNull();
    const none = buildPerSessionGroupSwitchState({
      group: createGroup(), nowMs: 1_000, memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS,
      accountUsageStore: null, runtimeQuotaSnapshots: null,
    });
    expect([...none.memberStatesByProfileId.values()].every((s) => (s.quotaSnapshot ?? null) === null)).toBe(true);
  });
});
