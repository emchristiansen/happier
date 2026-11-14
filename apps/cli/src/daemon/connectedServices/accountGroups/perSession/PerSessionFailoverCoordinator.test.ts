import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { normalizeConnectedServiceAuthGroupPolicy } from '../switching/buildConnectedServiceAuthGroupSwitchState';
import type { ConnectedServiceAuthGroupSwitchState } from '../switching/pipeline/switchPipeline';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionFailoverCoordinator, type PerSessionSessionBinding } from './PerSessionFailoverCoordinator';

const NOW = 2_000_000;

function group(policy: Record<string, unknown> = { strategy: 'per_session_softmax', autoSwitch: true, recoveryMode: 'switch_then_resume' }): ConnectedServiceAuthGroupV1 {
  const member = (profileId: string, priority: number) => ({
    v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'pool', profileId,
    enabled: true, priority, state: { v: 1 as const }, createdAt: priority, updatedAt: priority,
  });
  return {
    v: 1, serviceId: 'claude-subscription', groupId: 'pool', displayName: null,
    activeProfileId: 'a', generation: 4, runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, ...policy }),
    state: { v: 1 }, members: [member('a', 1), member('b', 2), member('c', 3)], createdAt: 1, updatedAt: 1,
  };
}

function stateFor(source: ConnectedServiceAuthGroupV1, scores: Record<string, number | null>): ConnectedServiceAuthGroupSwitchState {
  const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
  for (const [profileId, score] of Object.entries(scores)) {
    if (score !== null) memberStatesByProfileId.set(profileId, { quotaSnapshot: { capturedAtMs: NOW - 1, effectiveRemainingPercent: score } });
  }
  return {
    serviceId: source.serviceId, groupId: source.groupId, activeProfileId: source.activeProfileId,
    lastSwitchReason: null, lastSwitchAt: null, generation: source.generation, runtimeStateRevision: 0,
    policy: normalizeConnectedServiceAuthGroupPolicy(source.policy),
    members: source.members.map((member) => ({ profileId: member.profileId, priority: member.priority, enabled: member.enabled, createdAtMs: member.createdAt })),
    memberStatesByProfileId,
  } as ConnectedServiceAuthGroupSwitchState;
}

async function fixture(options: Readonly<{
  policy?: Record<string, unknown>;
  scores?: Record<string, number | null>;
  binding?: PerSessionSessionBinding;
}> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'per-session-failover-'));
  const ledger = new PerSessionAssignmentLedger(join(dir, 'ledger.json'));
  const source = group(options.policy);
  let binding: PerSessionSessionBinding = options.binding ?? {
    subjectId: 'csm_1',
    member: { assignment: 'per_session', profileId: 'a', decisionId: 'spawn-1', reason: 'initial_sampled', appliedAtMs: 1 },
    currentProfileId: 'a',
  };
  const applyAssignment = vi.fn(async (input: Parameters<ConstructorParameters<typeof PerSessionFailoverCoordinator>[0]['applyAssignment']>[0]) => {
    binding = { ...binding, materializedAssignment: input.binding.materializedAssignment };
    return { ok: true, action: 'restart_requested' };
  });
  const recordFailure = vi.fn(async () => {});
  const coordinator = new PerSessionFailoverCoordinator({
    loadGroup: async () => source,
    buildState: (loaded) => stateFor(loaded, options.scores ?? { a: 0, b: 80, c: 40 }),
    recordFailure,
    readSessionBinding: () => binding,
    applyAssignment,
    ledger,
    ownerMachineId: 'machine-1',
    reservationApi: null,
    quotaFreshnessMs: 300_000,
    nowMs: () => NOW,
    deadlineMs: 30_000,
    uniformSample: () => 0.5,
  });
  return { coordinator, ledger, applyAssignment, recordFailure, getBinding: () => binding };
}

const failure = { sessionId: 's-1', serviceId: 'claude-subscription', groupId: 'pool', reason: 'usage_limit', observedProfileId: 'a' } as const;

describe('PerSessionFailoverCoordinator', () => {
  it('owns sessions only in per_session_softmax groups', async () => {
    expect(await (await fixture()).coordinator.owns(failure)).toBe(true);
    expect(await (await fixture({ policy: { strategy: 'priority' } })).coordinator.owns(failure)).toBe(false);
    expect(await (await fixture()).coordinator.owns({ ...failure, sessionId: undefined })).toBe(false);
  });

  it('moves only the failing session onto its own replacement, keeping the applied member until adoption', async () => {
    const f = await fixture();
    const result = await f.coordinator.switchAfterClassifiedFailure(failure);
    expect(f.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ observedProfileId: 'a', reason: 'usage_limit' }));
    expect(result).toMatchObject({ status: 'switched', generation: 4, mode: 'restart_resume' });
    const applied = f.applyAssignment.mock.calls[0]![0];
    expect(applied.profileId).not.toBe('a');
    expect(applied.generation).toBe(4);
    expect(applied.binding).toMatchObject({
      selection: 'group', groupId: 'pool',
      member: { profileId: 'a' },
      materializedAssignment: { profileId: applied.profileId, reason: 'failover', fromProfileId: 'a' },
    });
    expect(f.ledger.list()).toEqual([expect.objectContaining({ origin: 'recovery', sessionId: 'csm_1', state: 'pending' })]);
  });

  it('does not repeat the effect when the same failure is replayed after application', async () => {
    const f = await fixture();
    await f.coordinator.switchAfterClassifiedFailure(failure);
    const second = await f.coordinator.switchAfterClassifiedFailure(failure);
    expect(second).toMatchObject({ status: 'switched' });
    expect(f.applyAssignment).toHaveBeenCalledTimes(1);
  });

  it('treats a report for an account the session no longer serves on as superseded', async () => {
    const f = await fixture();
    const result = await f.coordinator.switchAfterClassifiedFailure({ ...failure, observedProfileId: 'c' });
    expect(result).toMatchObject({ status: 'observed_generation', activeProfileId: 'a' });
    expect(f.applyAssignment).not.toHaveBeenCalled();
  });

  it('respects autoSwitch:false without choosing or applying', async () => {
    const f = await fixture({ policy: { strategy: 'per_session_softmax', autoSwitch: false, recoveryMode: 'switch_then_resume' } });
    const result = await f.coordinator.switchAfterClassifiedFailure(failure);
    expect(result).toEqual({ status: 'auto_switch_disabled', generation: 4 });
    expect(f.applyAssignment).not.toHaveBeenCalled();
    expect(f.ledger.list()).toHaveLength(0);
  });

  it('returns no_eligible_member with no effect when every other member is exhausted', async () => {
    const f = await fixture({ scores: { a: 0, b: 0, c: 0 } });
    const result = await f.coordinator.switchAfterClassifiedFailure(failure);
    expect(result).toMatchObject({ status: 'no_eligible_member', groupExhausted: true });
    expect(f.applyAssignment).not.toHaveBeenCalled();
  });

  it('supersedes a pending target that failed before adoption and draws without it', async () => {
    const f = await fixture({
      binding: {
        subjectId: 'csm_1',
        member: { assignment: 'per_session', profileId: 'a', decisionId: 'spawn-1', reason: 'initial_sampled', appliedAtMs: 1 },
        materializedAssignment: { profileId: 'b', decisionId: 'recovery-old', reason: 'failover', materializedAtMs: 2 },
        currentProfileId: 'a',
      },
      scores: { a: 60, b: 0, c: 50 },
    });
    await f.ledger.recordProposal({
      decisionId: 'recovery-old', sessionId: 'csm_1', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', nowMs: 1,
      proposal: {
        decisionId: 'recovery-old', proposalRevision: 1, profileId: 'b', reason: 'failover', fromProfileId: 'a',
        temperature: 1.5, offsetPercent: 10, probability: 0.5, decidedAtMs: 1, custody: 'local_degraded', observedReservationRevision: null,
      },
    });
    const result = await f.coordinator.switchAfterClassifiedFailure({ ...failure, observedProfileId: 'b' });
    expect(result).toMatchObject({ status: 'switched' });
    expect(f.ledger.get('recovery-old')).toBeNull();
    expect(f.applyAssignment.mock.calls[0]![0].profileId).not.toBe('b');
  });
});
