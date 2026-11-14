import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';

import { createConnectedServiceMaterializationIdentity } from '../../materialize/createConnectedServiceMaterializationIdentity';
import { collectPerSessionLiveDecisions } from './collectPerSessionLiveDecisions';
import type { PerSessionAssignmentProposal } from './decidePerSessionGroupMember';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import {
  PER_SESSION_RESERVATION_LEASE_MS,
  PER_SESSION_UNOWNED_DECISION_GRACE_MS,
  PerSessionAssignmentRuntime,
  type PerSessionLiveDecision,
} from './PerSessionAssignmentRuntime';

function proposal(decisionId: string, profileId: string): PerSessionAssignmentProposal {
  return {
    decisionId, proposalRevision: 1, profileId, reason: 'initial_sampled', fromProfileId: null,
    temperature: 1.5, offsetPercent: 10, probability: 0.4, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 3,
  };
}

async function ledgerAt() {
  const dir = await mkdtemp(join(tmpdir(), 'per-session-ledger-'));
  return join(dir, 'connected-services', 'per-session-assignments.json');
}

function reservationApi(overrides: Partial<ConnectedServiceAssignmentReservationApi> = {}) {
  return {
    listAssignmentReservations: vi.fn(async () => ({ kind: 'ok' as const, reservationRevision: 0, reservations: [] })),
    putAssignmentReservation: vi.fn(async (params: Parameters<ConnectedServiceAssignmentReservationApi['putAssignmentReservation']>[0]) => ({
      kind: 'reserved' as const, outcome: 'updated' as const, reservationRevision: 1,
      reservation: { decisionId: params.decisionId, ...params.body, createdAtMs: 0 },
    })),
    deleteAssignmentReservation: vi.fn(async () => ({ kind: 'ok' as const, reservationRevision: 2, deleted: true })),
    ...overrides,
  } satisfies ConnectedServiceAssignmentReservationApi;
}

describe('PerSessionAssignmentLedger', () => {
  it('persists decisions across instances, marks applied, removes and counts by member', async () => {
    const path = await ledgerAt();
    const first = new PerSessionAssignmentLedger(path);
    await first.recordProposal({ decisionId: 'd1', sessionId: 's1', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('d1', 'a'), nowMs: 5 });
    await first.recordProposal({ decisionId: 'd2', sessionId: 's2', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('d2', 'a'), nowMs: 5 });
    await first.recordProposal({ decisionId: 'd3', sessionId: 's3', serviceId: 'claude-subscription', groupId: 'other', origin: 'spawn', proposal: proposal('d3', 'a'), nowMs: 5 });
    expect(await first.markApplied('d1', 9)).toBe(true);

    const second = new PerSessionAssignmentLedger(path);
    expect(second.get('d1')).toMatchObject({ state: 'applied', updatedAtMs: 9, proposal: { profileId: 'a' } });
    expect(second.localCounts('claude-subscription', 'pool')).toEqual(new Map([['a', 2]]));
    expect(second.localCounts('claude-subscription', 'pool', 'd2')).toEqual(new Map([['a', 1]]));
    expect(await second.remove('d2')).toMatchObject({ decisionId: 'd2' });
    expect(new PerSessionAssignmentLedger(path).list().map((entry) => entry.decisionId).sort()).toEqual(['d1', 'd3']);
  });
});

describe('PerSessionAssignmentRuntime', () => {
  it('marks a proved adoption applied in the ledger and the shared resource, releasing the prior decision', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'old', sessionId: 'csm_1', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('old', 'a'), nowMs: 1 });
    await ledger.markApplied('old', 2);
    await ledger.recordProposal({ decisionId: 'new', sessionId: 'csm_1', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', proposal: proposal('new', 'b'), nowMs: 3 });
    const api = reservationApi();
    const runtime = new PerSessionAssignmentRuntime({ ledger, ownerMachineId: 'm1', reservationApi: api, nowMs: () => 100, listLiveDecisions: () => [] });

    await runtime.markAdopted({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'new', profileId: 'b' });

    expect(ledger.get('new')).toMatchObject({ state: 'applied' });
    expect(api.putAssignmentReservation).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'new',
      body: expect.objectContaining({ profileId: 'b', sessionId: 'csm_1', ownerMachineId: 'm1', state: 'applied', leaseUntilMs: 100 + PER_SESSION_RESERVATION_LEASE_MS }),
    }));
    expect(ledger.get('old')).toBeNull();
    expect(api.deleteAssignmentReservation).toHaveBeenCalledWith({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'old' });
  });

  it('renews live decisions, rebuilds a lost entry, and releases an unowned one only after the grace period', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'fresh', sessionId: 'csm_2', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('fresh', 'a'), nowMs: 1_000 });
    await ledger.recordProposal({ decisionId: 'stale', sessionId: 'csm_3', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('stale', 'a'), nowMs: 0 });
    const live: PerSessionLiveDecision = {
      serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'lost', profileId: 'b', subjectId: 'csm_1', applied: true, reason: 'failover',
    };
    const api = reservationApi();
    const now = PER_SESSION_UNOWNED_DECISION_GRACE_MS + 500;
    const runtime = new PerSessionAssignmentRuntime({ ledger, ownerMachineId: 'm1', reservationApi: api, nowMs: () => now, listLiveDecisions: () => [live] });

    await runtime.tick();

    expect(ledger.get('lost')).toMatchObject({ state: 'applied', sessionId: 'csm_1', proposal: { profileId: 'b', reason: 'failover' } });
    expect(ledger.get('fresh')).not.toBeNull();
    expect(ledger.get('stale')).toBeNull();
    const renewed = vi.mocked(api.putAssignmentReservation).mock.calls.map(([params]) => params.decisionId).sort();
    expect(renewed).toEqual(['fresh', 'lost']);
    expect(api.deleteAssignmentReservation).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 'stale' }));
  });

  it('recreates a lapsed reservation against the revision a conflict returns', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    const put = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict', reservationRevision: 7, reservations: [] })
      .mockResolvedValueOnce({ kind: 'reserved', outcome: 'created', reservationRevision: 8, reservation: {} });
    const runtime = new PerSessionAssignmentRuntime({
      ledger, ownerMachineId: 'm1', reservationApi: reservationApi({ putAssignmentReservation: put }), nowMs: () => 10,
      listLiveDecisions: () => [{ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'd', profileId: 'a', subjectId: 'csm', applied: false, reason: 'initial_sampled' }],
    });
    await runtime.tick();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![0].body).toMatchObject({ profileId: 'a', state: 'pending', expectedReservationRevision: 7 });
  });
});

describe('collectPerSessionLiveDecisions', () => {
  const member = { assignment: 'per_session' as const, profileId: 'a', decisionId: 'applied-1', reason: 'initial_sampled' as const, appliedAtMs: 1 };
  it('prefers session metadata over launch bindings and keys decisions by materialization identity', () => {
    const identity = createConnectedServiceMaterializationIdentity();
    const decisions = collectPerSessionLiveDecisions([{
      happySessionId: 'sess-1',
      happySessionMetadataFromLocalWebhook: {
        connectedServiceMaterializationIdentityV1: identity,
        connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', member } } },
      },
      spawnOptions: {
        connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
          source: 'connected', selection: 'group', groupId: 'pool',
          materializedAssignment: { profileId: 'a', decisionId: 'applied-1', reason: 'initial_sampled', materializedAtMs: 1 },
        } } },
      },
    }]);
    expect(decisions).toEqual([expect.objectContaining({ decisionId: 'applied-1', applied: true, profileId: 'a', groupId: 'pool' })]);
    expect(decisions[0]!.subjectId).toBe(identity.id);
  });

  it('reports a pending target as not applied and ignores shared group bindings', () => {
    const decisions = collectPerSessionLiveDecisions([
      { happySessionId: 's', spawnOptions: { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
        source: 'connected', selection: 'group', groupId: 'pool', member,
        materializedAssignment: { profileId: 'b', decisionId: 'pending-2', reason: 'failover', materializedAtMs: 2 },
      } } } } },
      { happySessionId: 't', spawnOptions: { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } } } } },
    ]);
    expect(decisions).toEqual([expect.objectContaining({ decisionId: 'pending-2', profileId: 'b', applied: false, subjectId: 's' })]);
  });
});
