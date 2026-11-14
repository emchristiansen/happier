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
  PerSessionAssignmentRuntime,
  type PerSessionLiveDecision,
  type PerSessionProvedSharedConversion,
  type PerSessionRunnerPresence,
} from './PerSessionAssignmentRuntime';

function runtimeFor(input: Readonly<{
  ledger: PerSessionAssignmentLedger;
  api: ReturnType<typeof reservationApi>;
  now?: () => number;
  live?: () => PerSessionLiveDecision[];
  liveSubjects?: () => ReadonlySet<string>;
  presence?: (pid: number) => PerSessionRunnerPresence;
  conversions?: () => ReadonlyArray<PerSessionProvedSharedConversion>;
  snapshotCapturedAt?: (profileId: string) => number | null;
}>) {
  return new PerSessionAssignmentRuntime({
    ledger: input.ledger,
    ownerMachineId: 'm1',
    reservationApi: input.api,
    nowMs: input.now ?? (() => 100),
    listLiveDecisions: input.live ?? (() => []),
    listLiveSubjectIds: input.liveSubjects ?? (() => new Set()),
    probeRunnerPresence: async (runner) => input.presence?.(runner.pid) ?? 'present',
    ...(input.conversions ? { listProvedSharedConversions: input.conversions } : {}),
    ...(input.snapshotCapturedAt ? { readMemberSnapshotCapturedAtMs: ({ profileId }: { profileId: string }) => input.snapshotCapturedAt!(profileId) } : {}),
  });
}

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
    const runtime = runtimeFor({ ledger, api });

    await runtime.markAdopted({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'new', profileId: 'b' });

    expect(ledger.get('new')).toMatchObject({ state: 'applied' });
    expect(api.putAssignmentReservation).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'new',
      body: expect.objectContaining({ profileId: 'b', sessionId: 'csm_1', ownerMachineId: 'm1', state: 'applied', leaseUntilMs: 100 + PER_SESSION_RESERVATION_LEASE_MS }),
    }));
    expect(ledger.get('old')).toBeNull();
    expect(api.deleteAssignmentReservation).toHaveBeenCalledWith({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'old' });
  });

  it('renews live decisions and rebuilds a lost entry', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'fresh', sessionId: 'csm_2', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('fresh', 'a'), nowMs: 1_000 });
    const live: PerSessionLiveDecision = {
      serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'lost', profileId: 'b', subjectId: 'csm_1', applied: true, reason: 'failover',
    };
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api, now: () => 5_000, live: () => [live] });

    await runtime.tick();

    expect(ledger.get('lost')).toMatchObject({ state: 'applied', sessionId: 'csm_1', proposal: { profileId: 'b', reason: 'failover' } });
    const renewed = vi.mocked(api.putAssignmentReservation).mock.calls.map(([params]) => params.decisionId).sort();
    expect(renewed).toEqual(['fresh', 'lost']);
    expect(api.deleteAssignmentReservation).not.toHaveBeenCalled();
  });

  it('keeps custody of an unresolved spawn with no live owner however much time passes (T17)', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'pre-registration', sessionId: 'csm_9', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('pre-registration', 'a'), nowMs: 0 });
    const api = reservationApi();
    // A day later, still no tracked child and no recorded runner: a pending child may exist.
    const runtime = runtimeFor({ ledger, api, now: () => 24 * 60 * 60_000 });

    await runtime.tick();
    await runtime.tick();

    expect(ledger.get('pre-registration')).not.toBeNull();
    expect(api.deleteAssignmentReservation).not.toHaveBeenCalled();
    expect(vi.mocked(api.putAssignmentReservation).mock.calls.map(([params]) => params.decisionId)).toEqual(['pre-registration', 'pre-registration']);
  });

  it('releases an unowned decision only once its recorded runner is proved absent', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'launched', sessionId: 'csm_4', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('launched', 'a'), nowMs: 0 });
    const runtime0 = runtimeFor({ ledger, api: reservationApi() });
    const custody = runtime0.createSpawnCustody();
    custody.claim(['launched']);
    await custody.recordRunner({ pid: 4242, processInstanceFingerprint: 'linux-proc:1' });
    expect(ledger.get('launched')?.runner).toEqual({ pid: 4242, processInstanceFingerprint: 'linux-proc:1' });

    let presence: PerSessionRunnerPresence = 'unknown';
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api, presence: () => presence });
    await runtime.tick();
    expect(ledger.get('launched')).not.toBeNull();

    presence = 'absent';
    await runtime.tick();
    expect(ledger.get('launched')).toBeNull();
    expect(api.deleteAssignmentReservation).toHaveBeenCalledWith({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'launched' });
  });

  it('releases a spawn decision after a definite pre-launch failure, but never once a runner existed', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'never-launched', sessionId: 'csm_5', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('never-launched', 'a'), nowMs: 0 });
    await ledger.recordProposal({ decisionId: 'launched', sessionId: 'csm_6', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('launched', 'a'), nowMs: 0 });
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api });

    const failed = runtime.createSpawnCustody();
    failed.claim(['never-launched']);
    await failed.releaseIfNeverLaunched();
    const launched = runtime.createSpawnCustody();
    launched.claim(['launched']);
    await launched.recordRunner({ pid: 77 });
    await launched.releaseIfNeverLaunched();

    expect(ledger.get('never-launched')).toBeNull();
    expect(ledger.get('launched')).not.toBeNull();
    expect(vi.mocked(api.deleteAssignmentReservation).mock.calls.map(([params]) => params.decisionId)).toEqual(['never-launched']);
  });

  it('on adoption releases the previous applied and superseded failed targets, keeping a newer pending proposal', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    const record = async (decisionId: string, profileId: string, replacesDecisionIds?: ReadonlyArray<string>) => ledger.recordProposal({
      decisionId, sessionId: 'csm_1', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', proposal: proposal(decisionId, profileId), nowMs: 1,
      ...(replacesDecisionIds ? { replacesDecisionIds } : {}),
    });
    await record('applied-a', 'a');
    await ledger.markApplied('applied-a', 2);
    await record('failed-b', 'b');
    await record('failed-c', 'c', ['failed-b']);
    await record('adopted-d', 'd', ['failed-c']);
    await record('newer-e', 'e');
    // The failed targets are not rewritten when replaced: they keep their own custody until adoption.
    expect(ledger.get('failed-b')?.state).toBe('pending');
    const runtime = runtimeFor({ ledger, api: reservationApi() });

    await runtime.markAdopted({ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'adopted-d', profileId: 'd' });

    expect(ledger.list().map((entry) => entry.decisionId).sort()).toEqual(['adopted-d', 'newer-e']);
  });

  it('releases an applied decision a live session no longer carries, and all of a retired session', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'old-applied', sessionId: 'csm_live', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('old-applied', 'a'), nowMs: 1 });
    await ledger.markApplied('old-applied', 1);
    await ledger.recordProposal({ decisionId: 'pending-recovery', sessionId: 'csm_live', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', proposal: proposal('pending-recovery', 'b'), nowMs: 1 });
    await ledger.recordProposal({ decisionId: 'ended', sessionId: 'csm_gone', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('ended', 'a'), nowMs: 1 });
    const runtime = runtimeFor({ ledger, api: reservationApi(), liveSubjects: () => new Set(['csm_live']) });

    await runtime.tick();
    expect(ledger.get('old-applied')).toBeNull();
    expect(ledger.get('pending-recovery')).not.toBeNull();

    await runtime.releaseForRetiredSubjects(['csm_gone']);
    expect(ledger.get('ended')).toBeNull();
  });

  it('recreates a lapsed reservation against the revision a conflict returns', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    const put = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict', reservationRevision: 7, reservations: [] })
      .mockResolvedValueOnce({ kind: 'reserved', outcome: 'created', reservationRevision: 8, reservation: {} });
    const runtime = runtimeFor({
      ledger, api: reservationApi({ putAssignmentReservation: put }), now: () => 10,
      live: () => [{ serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'd', profileId: 'a', subjectId: 'csm', applied: true, reason: 'initial_sampled' }],
    });
    await runtime.tick();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![0].body).toMatchObject({ profileId: 'a', state: 'applied', expectedReservationRevision: 7 });
  });

  it('never renews or CAS-refreshes a decision whose admission the decision owner has not settled (HPI-14)', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({
      decisionId: 'proposed', sessionId: 'csm_p', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn',
      proposal: { ...proposal('proposed', 'a'), custody: 'proposed', observedReservationRevision: 0 }, nowMs: 0,
    });
    await ledger.recordProposal({ decisionId: 'reserved', sessionId: 'csm_r', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('reserved', 'b'), nowMs: 0 });
    const put = vi.fn(async () => ({ kind: 'conflict' as const, reservationRevision: 7, reservations: [] }));
    const runtime = runtimeFor({
      ledger, api: reservationApi({ putAssignmentReservation: put as never }),
      live: () => [
        { serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'proposed', profileId: 'a', subjectId: 'csm_p', applied: false, reason: 'initial_sampled' },
        { serviceId: 'claude-subscription', groupId: 'pool', decisionId: 'reserved', profileId: 'b', subjectId: 'csm_r', applied: false, reason: 'initial_sampled' },
      ],
    });
    await runtime.tick();
    // Only the admitted pending reservation is renewed, once; its conflict is not resolved by renewal.
    expect(put.mock.calls.map((call) => (call as unknown as [{ decisionId: string }])[0].decisionId)).toEqual(['reserved']);
    expect(ledger.get('proposed')?.proposal).toMatchObject({ custody: 'proposed', observedReservationRevision: 0, proposalRevision: 1 });
  });

  it('keeps the previous applied member while a live runner also carries an unadopted target (HPI-15)', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    await ledger.recordProposal({ decisionId: 'old', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('old', 'a'), nowMs: 0 });
    await ledger.markApplied('old', 1);
    await ledger.recordProposal({ decisionId: 'new', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', proposal: proposal('new', 'b'), nowMs: 2 });
    const api = reservationApi();
    const children = [{ happySessionId: 's', spawnOptions: { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
      source: 'connected', selection: 'group', groupId: 'pool',
      member: { assignment: 'per_session', profileId: 'a', decisionId: 'old', reason: 'initial_sampled', appliedAtMs: 1 },
      materializedAssignment: { profileId: 'b', decisionId: 'new', reason: 'failover', fromProfileId: 'a', materializedAtMs: 2 },
    } } } } }];
    const runtime = runtimeFor({
      ledger, api,
      live: () => collectPerSessionLiveDecisions(children as never),
      liveSubjects: () => new Set(['s']),
    });
    await runtime.tick();
    expect(ledger.get('old')?.state).toBe('applied');
    expect(ledger.get('new')?.state).toBe('pending');
    expect(api.deleteAssignmentReservation).not.toHaveBeenCalled();
  });

  it('settles every decision of a session whose conversion to the shared home was proved (HPI-17)', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    const record = async (decisionId: string, profileId: string, replacesDecisionIds?: ReadonlyArray<string>) => ledger.recordProposal({
      decisionId, sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'recovery', proposal: proposal(decisionId, profileId), nowMs: 1,
      ...(replacesDecisionIds ? { replacesDecisionIds } : {}),
    });
    await record('applied-a', 'a');
    await ledger.markApplied('applied-a', 2);
    await record('failed-b', 'b');
    await record('pending-c', 'c', ['failed-b']);
    await ledger.recordProposal({ decisionId: 'other', sessionId: 'peer', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('other', 'a'), nowMs: 1 });
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api, liveSubjects: () => new Set(['s', 'peer']) });

    await runtime.settleProvedSharedConversion({ subjectId: 's', serviceId: 'claude-subscription', groupId: 'pool' });
    await runtime.tick();

    expect(ledger.list().map((entry) => entry.decisionId)).toEqual(['other']);
    expect(vi.mocked(api.deleteAssignmentReservation).mock.calls.map(([params]) => params.decisionId).sort()).toEqual(['applied-a', 'failed-b', 'pending-c']);
  });

  it('keeps custody once a launch adapter was entered, even when no runner pid was observed (HPI-02)', async () => {
    const ledgerPath = await ledgerAt();
    const ledger = new PerSessionAssignmentLedger(ledgerPath);
    await ledger.recordProposal({ decisionId: 'attempted', sessionId: 'csm_7', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal('attempted', 'a'), nowMs: 0 });
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api });
    const custody = runtime.createSpawnCustody();
    custody.claim(['attempted']);
    await custody.markLaunchAttempted();
    await custody.releaseIfNeverLaunched();
    expect(ledger.get('attempted')).not.toBeNull();
    expect(api.deleteAssignmentReservation).not.toHaveBeenCalled();

    // The attempt record is durable: after a daemon restart neither the pre-launch release nor a
    // replayed spawn may release it without a recorded runner proved absent.
    const restarted = runtimeFor({ ledger: new PerSessionAssignmentLedger(ledgerPath), api });
    expect(await restarted.releaseAfterDefinitePreLaunchFailure('attempted')).toBe(false);
    expect(await restarted.releaseReplayedSpawnDecision('attempted')).toBe(false);
    expect(restarted.spawnDeps.ledger.get('attempted')?.launchAttemptedAtMs).toBeTypeOf('number');
    expect(api.deleteAssignmentReservation).not.toHaveBeenCalled();
  });

  it('releases a replayed spawn decision that never launched, or whose recorded runner is proved absent', async () => {
    const ledger = new PerSessionAssignmentLedger(await ledgerAt());
    for (const id of ['never', 'gone', 'alive']) {
      await ledger.recordProposal({ decisionId: id, sessionId: `csm_${id}`, serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', proposal: proposal(id, 'a'), nowMs: 0 });
    }
    await ledger.recordRunner('gone', { pid: 1 }, 0);
    await ledger.recordRunner('alive', { pid: 2 }, 0);
    const api = reservationApi();
    const runtime = runtimeFor({ ledger, api, presence: (pid) => (pid === 1 ? 'absent' : 'present') });
    expect(await runtime.releaseReplayedSpawnDecision('never')).toBe(true);
    expect(await runtime.releaseReplayedSpawnDecision('gone')).toBe(true);
    expect(await runtime.releaseReplayedSpawnDecision('alive')).toBe(false);
    expect(ledger.list().map((entry) => entry.decisionId)).toEqual(['alive']);
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
    // The previous applied member still owns the session until the pending target is adopted (HPI-15).
    expect(decisions).toEqual([
      expect.objectContaining({ decisionId: 'applied-1', profileId: 'a', applied: true, subjectId: 's' }),
      expect.objectContaining({ decisionId: 'pending-2', profileId: 'b', applied: false, subjectId: 's' }),
    ]);
  });
});
