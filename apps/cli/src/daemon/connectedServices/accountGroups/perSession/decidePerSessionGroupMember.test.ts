import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceAssignmentReservationV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { decidePerSessionGroupMember, type PerSessionAssignmentProposal } from './decidePerSessionGroupMember';

const NOW = 5_000_000;
const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax' });

/** In-memory reservation server with the A.3 CAS semantics. */
function createFakeReservationServer(options: Readonly<{ beforePut?: (decisionId: string) => void }> = {}) {
  let revision = 0;
  const entries = new Map<string, ConnectedServiceAssignmentReservationV1>();
  const snapshot = () => ({ reservationRevision: revision, reservations: [...entries.values()] });
  const api: ConnectedServiceAssignmentReservationApi = {
    async listAssignmentReservations() {
      return { kind: 'ok', ...snapshot() };
    },
    async putAssignmentReservation({ decisionId, body }) {
      options.beforePut?.(decisionId);
      const existing = entries.get(decisionId);
      if (existing) {
        if (existing.profileId !== body.profileId || existing.sessionId !== body.sessionId) {
          return { kind: 'decision_mismatch', ...snapshot() };
        }
        return { kind: 'reserved', outcome: 'unchanged', reservationRevision: revision, reservation: existing };
      }
      if (body.expectedReservationRevision !== revision) return { kind: 'conflict', ...snapshot() };
      const reservation: ConnectedServiceAssignmentReservationV1 = {
        decisionId,
        profileId: body.profileId,
        sessionId: body.sessionId,
        ownerMachineId: body.ownerMachineId,
        state: body.state,
        createdAtMs: NOW,
        leaseUntilMs: body.leaseUntilMs,
      };
      entries.set(decisionId, reservation);
      revision += 1;
      return { kind: 'reserved', outcome: 'created', reservationRevision: revision, reservation };
    },
    async deleteAssignmentReservation({ decisionId }) {
      const deleted = entries.delete(decisionId);
      if (deleted) revision += 1;
      return { kind: 'ok', reservationRevision: revision, deleted };
    },
  };
  return {
    api,
    entries,
    bumpRevisionWithUnrelatedCommit() {
      entries.set(`other-${revision}`, {
        decisionId: `other-${revision}`, profileId: 'unrelated', sessionId: 'other', ownerMachineId: 'm2',
        state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 1_000_000,
      });
      revision += 1;
    },
  };
}

function poolOf(scores: Record<string, number | null>) {
  const members = Object.keys(scores).map((profileId, index) => ({ profileId, priority: index + 1, createdAtMs: index, enabled: true }));
  const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
  for (const [profileId, score] of Object.entries(scores)) {
    if (score !== null) {
      memberStatesByProfileId.set(profileId, { quotaSnapshot: { capturedAtMs: NOW - 1, effectiveRemainingPercent: score } });
    }
  }
  return { members, memberStatesByProfileId };
}

function baseInput(overrides: Partial<Parameters<typeof decidePerSessionGroupMember>[0]> & {
  scores: Record<string, number | null>;
}) {
  const { scores, ...rest } = overrides;
  const persisted: PerSessionAssignmentProposal[] = [];
  const input = {
    serviceId: 'claude-subscription' as const,
    groupId: 'pool',
    sessionId: 'session-1',
    ownerMachineId: 'machine-1',
    decisionId: 'decision-1',
    policy,
    ...poolOf(scores),
    quotaFreshnessMs: 300_000,
    nowMs: () => NOW,
    currentProfileId: null,
    reservationApi: null,
    localReservationCountsByProfileId: () => new Map<string, number>(),
    uniformSample: () => 0,
    persistProposal: async (proposal: PerSessionAssignmentProposal) => { persisted.push(proposal); },
    deadlineAtMs: NOW + 60_000,
    ...rest,
  };
  return { input, persisted };
}

describe('decidePerSessionGroupMember', () => {
  it('persists a proposed decision before reserving, then records reserved custody', async () => {
    const server = createFakeReservationServer();
    const order: string[] = [];
    const { input, persisted } = baseInput({
      scores: { a: 100, b: 50 },
      reservationApi: {
        ...server.api,
        putAssignmentReservation: async (params) => { order.push(`put:${persisted.length}`); return server.api.putAssignmentReservation(params); },
      },
    });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision.kind).toBe('assigned');
    expect(persisted.map((proposal) => proposal.custody)).toEqual(['proposed', 'reserved']);
    expect(order).toEqual(['put:1']);
    expect(server.entries.get('decision-1')).toMatchObject({ profileId: 'a', state: 'pending', leaseUntilMs: NOW + 300_000 });
    if (decision.kind === 'assigned') {
      expect(decision.proposal).toMatchObject({ reason: 'initial_sampled', temperature: 1.5, offsetPercent: 10 });
    }
  });

  it('starts an eligible named member without a draw and keeps it through unrelated revision conflicts (HSO-02)', async () => {
    let conflicts = 0;
    const server = createFakeReservationServer({
      beforePut: () => { if (conflicts < 2) { conflicts += 1; server.bumpRevisionWithUnrelatedCommit(); } },
    });
    const { input, persisted } = baseInput({
      scores: { a: 20, b: 100 },
      initialProfileId: 'a',
      reservationApi: server.api,
      uniformSample: () => 0.99,
    });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { profileId: 'a', reason: 'initial_requested', custody: 'reserved' } });
    expect(conflicts).toBe(2);
    expect(new Set(persisted.map((proposal) => proposal.profileId))).toEqual(new Set(['a']));
    expect(persisted.map((proposal) => proposal.proposalRevision)).toEqual([1, 2, 3, 3]);
  });

  it('fails over from an ineligible named member and retains the request reason', async () => {
    const { input } = baseInput({ scores: { a: 0, b: 60 }, initialProfileId: 'a' });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { profileId: 'b', reason: 'initial_unavailable_failover' } });
  });

  it('rejects a named member that is not in the group', async () => {
    const { input } = baseInput({ scores: { a: 50 }, initialProfileId: 'zzz' });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({
      kind: 'initial_profile_invalid', profileId: 'zzz', code: 'initial_profile_not_member',
    });
  });

  it('rejects a disabled named member as configuration-invalid instead of failing over', async () => {
    const { input } = baseInput({ scores: { a: 80, b: 60 }, initialProfileId: 'a' });
    const disabled = { ...input, members: input.members.map((member) => (member.profileId === 'a' ? { ...member, enabled: false } : member)) };
    expect(await decidePerSessionGroupMember(disabled)).toMatchObject({
      kind: 'initial_profile_invalid', profileId: 'a', code: 'initial_profile_disabled',
    });
  });

  it('starts an eligible named member even when its quota is unknown', async () => {
    const { input } = baseInput({ scores: { a: null, b: 90 }, initialProfileId: 'a' });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({ kind: 'assigned', proposal: { profileId: 'a', reason: 'initial_requested' } });
  });

  it('recomputes a sampled choice after a definite conflict using the returned reservations', async () => {
    let first = true;
    const server = createFakeReservationServer({
      beforePut: () => {
        if (!first) return;
        first = false;
        // Another daemon committed two reservations on the fresh member meanwhile.
        for (const id of ['x1', 'x2']) {
          server.entries.set(id, { decisionId: id, profileId: 'fresh', sessionId: id, ownerMachineId: 'm2',
            state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 1_000_000 });
        }
        server.bumpRevisionWithUnrelatedCommit();
      },
    });
    const { input, persisted } = baseInput({ scores: { fresh: 100, other: 60 }, reservationApi: server.api, uniformSample: () => 0.6 });
    const decision = await decidePerSessionGroupMember(input);
    expect(persisted[0]!.profileId).toBe('fresh');
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { profileId: 'other', custody: 'reserved', proposalRevision: 2 } });
  });

  it('uses local degraded mode with doubled temperature only when the route is definitely unavailable', async () => {
    const unavailable: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => ({ kind: 'unavailable', detail: 'http_404' }),
      putAssignmentReservation: async () => { throw new Error('must not PUT when degraded'); },
      deleteAssignmentReservation: async () => ({ kind: 'unavailable', detail: 'http_404' }),
    };
    const events: string[] = [];
    const { input, persisted } = baseInput({
      scores: { a: 100, b: 50 },
      reservationApi: unavailable,
      log: (event) => { events.push(event); },
    });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { custody: 'local_degraded', temperature: 3 } });
    expect(persisted).toHaveLength(1);
    expect(events).toContain('assignment_reservation_unavailable');
  });

  it('keeps the original target on an uncertain PUT and reconciles it by exact read', async () => {
    const server = createFakeReservationServer();
    let calls = 0;
    const flaky: ConnectedServiceAssignmentReservationApi = {
      ...server.api,
      putAssignmentReservation: async (params) => {
        calls += 1;
        await server.api.putAssignmentReservation(params); // committed, but the response is lost
        return { kind: 'uncertain', detail: 'ECONNRESET' };
      },
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: flaky });
    const decision = await decidePerSessionGroupMember(input);
    expect(calls).toBe(1);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { profileId: 'a', custody: 'reserved' } });
    expect(new Set(persisted.map((proposal) => proposal.profileId))).toEqual(new Set(['a']));
  });

  it('proceeds on the same target with reservation_uncertain when reconciliation is impossible', async () => {
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: (() => {
        let first = true;
        return async () => {
          if (first) { first = false; return { kind: 'ok', reservationRevision: 0, reservations: [] }; }
          return { kind: 'uncertain', detail: 'timeout' };
        };
      })(),
      putAssignmentReservation: async () => ({ kind: 'uncertain', detail: 'timeout' }),
      deleteAssignmentReservation: async () => ({ kind: 'uncertain', detail: 'timeout' }),
    };
    const { input } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({
      kind: 'assigned', proposal: { profileId: 'a', custody: 'reservation_uncertain' },
    });
  });

  it('replays its own committed decision instead of overwriting it', async () => {
    const server = createFakeReservationServer();
    server.entries.set('decision-1', { decisionId: 'decision-1', profileId: 'b', sessionId: 'session-1', ownerMachineId: 'machine-1',
      state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 1_000 });
    const { input } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: server.api });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({ kind: 'assigned', proposal: { profileId: 'b', custody: 'reserved' } });
  });

  it('excludes the session\'s failed member on failover', async () => {
    const { input } = baseInput({ scores: { failed: 100, b: 30 }, currentProfileId: 'failed', switchReason: 'usage_limit' });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({ kind: 'assigned', proposal: { profileId: 'b', reason: 'failover', fromProfileId: 'failed' } });
  });

  it('T4: an eight-session S6 burst through shared reservations matches the modeled shared-count mean', async () => {
    // S6: thirteen members spread 20–45% plus one at 95%.
    const scores: Record<string, number> = {};
    for (let index = 0; index < 13; index += 1) scores[`m${index}`] = 20 + (25 * index) / 12;
    scores.A15 = 95;
    const trials = 4_000;
    let seed = 20261114;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let total = 0;
    let totalSquares = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const server = createFakeReservationServer();
      let onA15 = 0;
      for (let session = 0; session < 8; session += 1) {
        const { input } = baseInput({
          scores,
          reservationApi: server.api,
          sessionId: `s${session}`,
          decisionId: `t${trial}-s${session}`,
          uniformSample: random,
        });
        const decision = await decidePerSessionGroupMember(input);
        if (decision.kind === 'assigned' && decision.proposal.profileId === 'A15') onA15 += 1;
      }
      total += onA15;
      totalSquares += onA15 * onA15;
    }
    const mean = total / trials;
    const standardError = Math.sqrt((totalSquares / trials - mean * mean) / trials);
    expect(Math.abs(mean - 1.495)).toBeLessThanOrEqual(4 * standardError);
  }, 60_000);
});
