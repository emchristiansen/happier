import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceAssignmentReservationV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  decidePerSessionGroupMember,
  PerSessionReservationDecisionMismatchError,
  type PerSessionAssignmentProposal,
} from './decidePerSessionGroupMember';

const NOW = 5_000_000;
const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax' });

/** In-memory reservation server with the A.3 CAS semantics. */
function createFakeReservationServer(options: Readonly<{ beforePut?: (decisionId: string) => void; clock?: { now: number } }> = {}) {
  const clock = options.clock ?? { now: NOW };
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
        if (existing.profileId !== body.profileId || existing.sessionId !== body.sessionId
          || existing.ownerMachineId !== body.ownerMachineId) {
          return { kind: 'decision_mismatch', ...snapshot() };
        }
        return { kind: 'reserved', outcome: 'unchanged', reservationRevision: revision, reservation: existing };
      }
      if (body.expectedReservationRevision !== revision) return { kind: 'conflict', ...snapshot() };
      if (body.leaseUntilMs <= clock.now) return { kind: 'uncertain', detail: 'http_400' };
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

  it('proceeds on the same target with reservation_uncertain when reconciliation is impossible at the deadline', async () => {
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
    const { input } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, deadlineAtMs: NOW });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({
      kind: 'assigned', proposal: { profileId: 'a', custody: 'reservation_uncertain' },
    });
  });

  it('rejects a stored entry on another target as a decision mismatch instead of adopting it (HPI-07)', async () => {
    const server = createFakeReservationServer();
    server.entries.set('decision-1', { decisionId: 'decision-1', profileId: 'b', sessionId: 'session-1', ownerMachineId: 'machine-1',
      state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 1_000 });
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: server.api });
    await expect(decidePerSessionGroupMember(input)).rejects.toBeInstanceOf(PerSessionReservationDecisionMismatchError);
    expect(persisted.map((proposal) => [proposal.profileId, proposal.custody])).toEqual([['a', 'proposed']]);
    expect(server.entries.get('decision-1')!.profileId).toBe('b');
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

/** Records each PUT body together with how many proposals were durable when it was sent. */
function recording(api: ConnectedServiceAssignmentReservationApi, persisted: ReadonlyArray<PerSessionAssignmentProposal>) {
  const puts: Array<Readonly<{ body: unknown; durable: number }>> = [];
  const wrapped: ConnectedServiceAssignmentReservationApi = {
    ...api,
    putAssignmentReservation: async (params) => {
      puts.push({ body: structuredClone(params.body), durable: persisted.length });
      return api.putAssignmentReservation(params);
    },
  };
  return { api: wrapped, puts };
}

function lastOf(persisted: ReadonlyArray<PerSessionAssignmentProposal>): PerSessionAssignmentProposal {
  return persisted[persisted.length - 1]!;
}

const sentBody = (overrides: Readonly<{ profileId: string; leaseUntilMs: number; expectedReservationRevision: number }>) => ({
  profileId: overrides.profileId,
  sessionId: 'session-1',
  ownerMachineId: 'machine-1',
  state: 'pending',
  leaseUntilMs: overrides.leaseUntilMs,
  expectedReservationRevision: overrides.expectedReservationRevision,
});

describe('decidePerSessionGroupMember reservation custody (A.5 R1–R5)', () => {
  it('HPI-05 replayNewRevision: a resumed proposal re-sends its identical PUT, then re-proposes durably only after the definite conflict', async () => {
    const clock = { now: NOW + 20_000 };
    const server = createFakeReservationServer({ clock });
    server.bumpRevisionWithUnrelatedCommit();
    const resumeProposal: PerSessionAssignmentProposal = {
      decisionId: 'decision-1', proposalRevision: 1, profileId: 'a', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.84, decidedAtMs: NOW, custody: 'proposed',
      observedReservationRevision: 0, reservationLeaseUntilMs: NOW + 300_000,
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, nowMs: () => clock.now, resumeProposal });
    const recorder = recording(server.api, persisted);
    const decision = await decidePerSessionGroupMember({ ...input, reservationApi: recorder.api });

    expect(recorder.puts[0]).toStrictEqual({ body: sentBody({ profileId: 'a', leaseUntilMs: NOW + 300_000, expectedReservationRevision: 0 }), durable: 0 });
    expect(persisted[0]).toMatchObject({ proposalRevision: 2, custody: 'proposed', observedReservationRevision: 1, reservationLeaseUntilMs: clock.now + 300_000 });
    expect(recorder.puts[1]).toStrictEqual({ body: sentBody({ profileId: persisted[0]!.profileId, leaseUntilMs: clock.now + 300_000, expectedReservationRevision: 1 }), durable: 1 });
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { decisionId: 'decision-1', proposalRevision: 2, custody: 'reserved' } });
    expect(server.entries.get('decision-1')).toMatchObject({ profileId: persisted[0]!.profileId });
  });

  it('HPI-05: a replay after intervening reservations and a changed clock sends a byte-identical PUT body', async () => {
    const clock = { now: NOW };
    const server = createFakeReservationServer({ clock });
    let healthy = false;
    let gets = 0;
    const flaky: ConnectedServiceAssignmentReservationApi = {
      ...server.api,
      // The initial read succeeds; reconciliation reads fail until the outage ends.
      listAssignmentReservations: async (params) => (healthy || gets++ === 0
        ? server.api.listAssignmentReservations(params)
        : { kind: 'uncertain', detail: 'timeout' }),
      putAssignmentReservation: async (params) => (healthy
        ? server.api.putAssignmentReservation(params)
        : { kind: 'uncertain', detail: 'ECONNRESET' }),
    };
    const first = baseInput({ scores: { a: 100, b: 50 }, nowMs: () => clock.now });
    const firstRecorder = recording(flaky, first.persisted);
    const unresolved = await decidePerSessionGroupMember({ ...first.input, reservationApi: firstRecorder.api });
    expect(unresolved).toMatchObject({ kind: 'custody_unresolved', pendingProposal: { profileId: 'a', proposalRevision: 1, custody: 'proposed' } });
    expect(first.persisted.map((proposal) => proposal.custody)).toEqual(['proposed']);

    server.bumpRevisionWithUnrelatedCommit();
    server.bumpRevisionWithUnrelatedCommit();
    clock.now = NOW + 45_000;
    healthy = true;
    const replay = baseInput({ scores: { a: 100, b: 50 }, nowMs: () => clock.now, resumeProposal: lastOf(first.persisted) });
    const replayRecorder = recording(flaky, replay.persisted);
    const decision = await decidePerSessionGroupMember({ ...replay.input, reservationApi: replayRecorder.api });

    expect(replayRecorder.puts[0]!.body).toStrictEqual(firstRecorder.puts[0]!.body);
    expect(JSON.stringify(replayRecorder.puts[0]!.body)).toBe(JSON.stringify(firstRecorder.puts[0]!.body));
    expect(replayRecorder.puts[1]).toMatchObject({ body: { expectedReservationRevision: 2, leaseUntilMs: clock.now + 300_000 }, durable: 1 });
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { proposalRevision: 2, custody: 'reserved' } });
  });

  it('HPI-05 uncertainResend: an empty newer GET re-sends the identical PUT; only its definite conflict permits a re-proposal', async () => {
    const server = createFakeReservationServer();
    let puts = 0;
    const lossy: ConnectedServiceAssignmentReservationApi = {
      ...server.api,
      putAssignmentReservation: async (params) => {
        puts += 1;
        if (puts === 1) {
          // Lost before commit while another daemon commits meanwhile.
          server.bumpRevisionWithUnrelatedCommit();
          return { kind: 'uncertain', detail: 'timeout' };
        }
        return server.api.putAssignmentReservation(params);
      },
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 } });
    const recorder = recording(lossy, persisted);
    const decision = await decidePerSessionGroupMember({ ...input, reservationApi: recorder.api });

    expect(recorder.puts[1]!.body).toStrictEqual(recorder.puts[0]!.body);
    expect(recorder.puts.map((put) => (put.body as { expectedReservationRevision: number }).expectedReservationRevision)).toEqual([0, 0, 1]);
    expect(persisted.map((proposal) => [proposal.proposalRevision, proposal.custody])).toEqual([[1, 'proposed'], [2, 'proposed'], [2, 'reserved']]);
    expect(recorder.puts[2]!.durable).toBe(2);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { proposalRevision: 2, custody: 'reserved' } });
  });

  it('HPI-06 uncertainThenUnavailable: a held-open original PUT completing late leaves decision A with one reservation and no degraded redraw', async () => {
    const server = createFakeReservationServer();
    let releaseOriginal!: () => void;
    const gate = new Promise<void>((resolve) => { releaseOriginal = resolve; });
    let originalCommitted: Promise<unknown> | null = null;
    let routeRefusing = true;
    const api: ConnectedServiceAssignmentReservationApi = {
      ...server.api,
      putAssignmentReservation: async (params) => {
        if (!originalCommitted) {
          // The request stays open server-side; the client only observes a timeout.
          originalCommitted = gate.then(() => server.api.putAssignmentReservation(params));
          return { kind: 'uncertain', detail: 'timeout' };
        }
        if (routeRefusing) return { kind: 'unavailable', detail: 'ECONNREFUSED' };
        return server.api.putAssignmentReservation(params);
      },
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, uniformSample: (() => { let draws = 0; return () => (draws++ === 0 ? 0 : 0.999); })() });
    const recorder = recording(api, persisted);
    const decision = await decidePerSessionGroupMember({ ...input, reservationApi: recorder.api });

    expect(decision).toMatchObject({ kind: 'custody_unresolved', pendingProposal: { profileId: 'a', proposalRevision: 1, custody: 'proposed', temperature: 1.5 } });
    expect(persisted.map((proposal) => [proposal.profileId, proposal.custody])).toEqual([['a', 'proposed']]);

    releaseOriginal();
    await originalCommitted;
    routeRefusing = false;
    const replay = baseInput({ scores: { a: 100, b: 50 }, resumeProposal: lastOf(persisted) });
    const replayRecorder = recording(api, replay.persisted);
    const settled = await decidePerSessionGroupMember({ ...replay.input, reservationApi: replayRecorder.api });

    expect(replayRecorder.puts[0]!.body).toStrictEqual(recorder.puts[0]!.body);
    expect(settled).toMatchObject({ kind: 'assigned', proposal: { decisionId: 'decision-1', profileId: 'a', proposalRevision: 1, custody: 'reserved' } });
    expect([...server.entries.values()].filter((entry) => entry.decisionId === 'decision-1').map((entry) => entry.profileId)).toEqual(['a']);
    expect(server.entries.size).toBe(1);
  });

  it('HPI-06: at the deadline a refused resend proceeds as reservation_uncertain on the same ID and target', async () => {
    let puts = 0;
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => ({ kind: 'ok', reservationRevision: 0, reservations: [] }),
      putAssignmentReservation: async () => (++puts === 1 ? { kind: 'uncertain', detail: 'timeout' } : { kind: 'unavailable', detail: 'ECONNREFUSED' }),
      deleteAssignmentReservation: async () => ({ kind: 'unavailable', detail: 'ECONNREFUSED' }),
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, deadlineAtMs: NOW });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toMatchObject({ kind: 'assigned', proposal: { profileId: 'a', proposalRevision: 1, custody: 'reservation_uncertain', temperature: 1.5 } });
    expect(new Set(persisted.map((proposal) => proposal.profileId))).toEqual(new Set(['a']));
    expect(persisted.some((proposal) => proposal.custody === 'local_degraded')).toBe(false);
  });

  it('HPI-06: a resumed proposal never degrades when the route is refused, since its PUT may already be committed', async () => {
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => ({ kind: 'unavailable', detail: 'http_404' }),
      putAssignmentReservation: async () => ({ kind: 'unavailable', detail: 'http_404' }),
      deleteAssignmentReservation: async () => ({ kind: 'unavailable', detail: 'http_404' }),
    };
    const resumeProposal: PerSessionAssignmentProposal = {
      decisionId: 'decision-1', proposalRevision: 1, profileId: 'b', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.16, decidedAtMs: NOW, custody: 'proposed',
      observedReservationRevision: 0, reservationLeaseUntilMs: NOW + 300_000,
    };
    const before = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, resumeProposal });
    expect(await decidePerSessionGroupMember(before.input)).toMatchObject({ kind: 'custody_unresolved', pendingProposal: { profileId: 'b' } });
    expect(before.persisted).toEqual([]);
    const atDeadline = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, resumeProposal, deadlineAtMs: NOW });
    expect(await decidePerSessionGroupMember(atDeadline.input)).toMatchObject({
      kind: 'assigned', proposal: { profileId: 'b', proposalRevision: 1, custody: 'reservation_uncertain' },
    });
  });

  it('HPI-07 mismatchSameSession: a server decision mismatch is an error, never a target rewrite', async () => {
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => ({ kind: 'ok', reservationRevision: 0, reservations: [] }),
      putAssignmentReservation: async () => ({
        kind: 'decision_mismatch', reservationRevision: 1,
        reservations: [{ decisionId: 'decision-1', profileId: 'b', sessionId: 'session-1', ownerMachineId: 'machine-1',
          state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 300_000 }],
      }),
      deleteAssignmentReservation: async () => ({ kind: 'ok', reservationRevision: 1, deleted: false }),
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api });
    const error = await decidePerSessionGroupMember(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PerSessionReservationDecisionMismatchError);
    expect(error).toMatchObject({ proposal: { profileId: 'a' }, stored: { profileId: 'b' } });
    expect(persisted.map((proposal) => [proposal.profileId, proposal.custody])).toEqual([['a', 'proposed']]);
  });

  it.each([
    ['profileId', { profileId: 'b' }],
    ['sessionId', { sessionId: 'session-2' }],
    ['ownerMachineId', { ownerMachineId: 'machine-2' }],
  ] as const)('HPI-07: an exact GET entry differing in %s fails without effect', async (_field, difference) => {
    const stored: ConnectedServiceAssignmentReservationV1 = {
      decisionId: 'decision-1', profileId: 'a', sessionId: 'session-1', ownerMachineId: 'machine-1',
      state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 300_000, ...difference,
    };
    let gets = 0;
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => (gets++ === 0
        ? { kind: 'ok', reservationRevision: 0, reservations: [] }
        : { kind: 'ok', reservationRevision: 1, reservations: [stored] }),
      putAssignmentReservation: async () => ({ kind: 'uncertain', detail: 'timeout' }),
      deleteAssignmentReservation: async () => ({ kind: 'ok', reservationRevision: 1, deleted: false }),
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api });
    await expect(decidePerSessionGroupMember(input)).rejects.toBeInstanceOf(PerSessionReservationDecisionMismatchError);
    expect(persisted.map((proposal) => proposal.custody)).toEqual(['proposed']);
  });

  it('HPI-07: an exact (decision, profile, session, owner) entry is R1 success on replay', async () => {
    const server = createFakeReservationServer();
    server.entries.set('decision-1', { decisionId: 'decision-1', profileId: 'b', sessionId: 'session-1', ownerMachineId: 'machine-1',
      state: 'pending', createdAtMs: NOW, leaseUntilMs: NOW + 300_000 });
    const resumeProposal: PerSessionAssignmentProposal = {
      decisionId: 'decision-1', proposalRevision: 1, profileId: 'b', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.16, decidedAtMs: NOW, custody: 'proposed',
      observedReservationRevision: 0, reservationLeaseUntilMs: NOW + 300_000,
    };
    const { input } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: server.api, resumeProposal });
    expect(await decidePerSessionGroupMember(input)).toMatchObject({ kind: 'assigned', proposal: { profileId: 'b', custody: 'reserved', probability: 0.16 } });
  });

  it('HPI-08 uncertainBeforeDeadline: an uncertain PUT with failed reconciliation is not effect-ready, then reserves normally on retry', async () => {
    const server = createFakeReservationServer();
    let outage = true;
    const api: ConnectedServiceAssignmentReservationApi = {
      ...server.api,
      listAssignmentReservations: (() => {
        let first = true;
        return async (params) => {
          if (first) { first = false; return server.api.listAssignmentReservations(params); }
          return outage ? { kind: 'uncertain', detail: 'timeout' } : server.api.listAssignmentReservations(params);
        };
      })(),
      putAssignmentReservation: async (params) => (outage ? { kind: 'uncertain', detail: 'timeout' } : server.api.putAssignmentReservation(params)),
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toEqual({
      kind: 'custody_unresolved',
      pendingProposal: lastOf(persisted),
      detail: 'reconcile_uncertain:timeout',
      deadlineAtMs: NOW + 60_000,
    });
    expect(persisted.map((proposal) => proposal.custody)).toEqual(['proposed']);

    outage = false;
    const retry = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, resumeProposal: lastOf(persisted) });
    expect(await decidePerSessionGroupMember(retry.input)).toMatchObject({
      kind: 'assigned', proposal: { decisionId: 'decision-1', profileId: 'a', proposalRevision: 1, custody: 'reserved' },
    });
  });

  it('HPI-08: the deadline-reached escape keeps the same ID and target and the original PUT for later reconciliation', async () => {
    const api: ConnectedServiceAssignmentReservationApi = {
      listAssignmentReservations: async () => ({ kind: 'uncertain', detail: 'timeout' }),
      putAssignmentReservation: async () => ({ kind: 'uncertain', detail: 'timeout' }),
      deleteAssignmentReservation: async () => ({ kind: 'uncertain', detail: 'timeout' }),
    };
    const resumeProposal: PerSessionAssignmentProposal = {
      decisionId: 'decision-1', proposalRevision: 3, profileId: 'b', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.16, decidedAtMs: NOW, custody: 'proposed',
      observedReservationRevision: 7, reservationLeaseUntilMs: NOW + 300_000,
    };
    const { input, persisted } = baseInput({ scores: { a: 100, b: 50 }, reservationApi: api, resumeProposal, nowMs: () => NOW + 60_000 });
    const decision = await decidePerSessionGroupMember(input);
    expect(decision).toEqual({ kind: 'assigned', proposal: { ...resumeProposal, custody: 'reservation_uncertain' } });
    expect(persisted).toEqual([{ ...resumeProposal, custody: 'reservation_uncertain' }]);
  });
});
