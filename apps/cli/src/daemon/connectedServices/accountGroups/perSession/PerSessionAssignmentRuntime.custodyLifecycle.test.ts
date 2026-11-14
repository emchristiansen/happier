import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import { NO_CONNECTED_SERVICE_MEMBER_HOLDS } from '../holds/connectedServiceMemberHolds';
import {
  collectPerSessionLiveDecisions,
  collectPerSessionLiveSubjectIds,
  collectPerSessionProvedSharedConversions,
} from './collectPerSessionLiveDecisions';
import type { PerSessionAssignmentProposal } from './decidePerSessionGroupMember';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime, type PerSessionRunnerPresence } from './PerSessionAssignmentRuntime';
import { PerSessionFailoverCoordinator } from './PerSessionFailoverCoordinator';
import { ConnectedServicePerSessionSpawnError, resolvePerSessionGroupMemberForSpawn } from './resolvePerSessionGroupMemberForSpawn';

/**
 * Custody lifecycle of per-session decisions across crashes, through the real ledger (on disk),
 * collector, runtime tick, coordinator and spawn resolver. Process presence, the reservation server
 * and quota snapshots are fixture boundaries.
 */
const serviceId = 'claude-subscription' as const;
const NOW = 1_000_000;

type Event = Readonly<{ put: string } | { delete: string }>;
type TrackedFixture = Readonly<{
  happySessionId: string;
  pid?: number;
  processInstanceFingerprint?: string;
  happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
  spawnOptions: Readonly<{ connectedServices: unknown }>;
}>;

function proposal(decisionId: string, profileId: string, decidedAtMs = 1): PerSessionAssignmentProposal {
  return {
    decisionId, profileId, proposalRevision: 1, reason: 'failover', fromProfileId: 'a', temperature: 1.5, offsetPercent: 10,
    probability: 1, decidedAtMs, custody: 'reserved', observedReservationRevision: 0,
  };
}

async function freshLedger() {
  const path = join(await mkdtemp(join(tmpdir(), 'per-session-custody-')), 'ledger.json');
  return { path, ledger: new PerSessionAssignmentLedger(path) };
}

async function record(
  ledger: PerSessionAssignmentLedger,
  decisionId: string,
  options: Readonly<{ profileId?: string; origin?: 'spawn' | 'recovery'; replaces?: string[]; sessionId?: string; decidedAtMs?: number }> = {},
) {
  await ledger.recordProposal({
    decisionId,
    sessionId: options.sessionId ?? 'subject',
    serviceId,
    groupId: 'g',
    origin: options.origin ?? 'recovery',
    proposal: proposal(decisionId, options.profileId ?? 'b', options.decidedAtMs),
    nowMs: 1,
    ...(options.replaces ? { replacesDecisionIds: options.replaces } : {}),
  });
}

function groupBindings(binding: Record<string, unknown>) {
  return { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'g', ...binding } } };
}

function launchedWith(binding: Record<string, unknown>, committed?: Record<string, unknown>): TrackedFixture[] {
  return [{
    happySessionId: 'subject',
    spawnOptions: { connectedServices: groupBindings(binding) },
    ...(committed ? { happySessionMetadataFromLocalWebhook: { connectedServices: groupBindings(committed) } } : {}),
  }];
}

function runtimeFor(ledger: PerSessionAssignmentLedger, sessions: () => ReadonlyArray<TrackedFixture>, options: Readonly<{
  events?: Event[];
  presence?: PerSessionRunnerPresence;
  failPut?: boolean;
  nowMs?: () => number;
  snapshotCapturedAt?: (profileId: string, nowMs: number) => number | null;
}> = {}) {
  const events = options.events ?? [];
  return new PerSessionAssignmentRuntime({
    ledger,
    ownerMachineId: 'm',
    nowMs: options.nowMs ?? (() => NOW),
    listLiveDecisions: () => collectPerSessionLiveDecisions(sessions()),
    listLiveSubjectIds: () => collectPerSessionLiveSubjectIds(sessions()),
    listProvedSharedConversions: () => collectPerSessionProvedSharedConversions(sessions()),
    ...(options.snapshotCapturedAt ? {
      readMemberSnapshotCapturedAtOrAfterMs: ({ profileId, nowMs }: { profileId: string; nowMs: number }) => options.snapshotCapturedAt!(profileId, nowMs),
    } : {}),
    probeRunnerPresence: async () => options.presence ?? 'unknown',
    reservationApi: {
      listAssignmentReservations: async () => ({ kind: 'unavailable', detail: 'fixture' }),
      putAssignmentReservation: async (put: any) => {
        events.push({ put: put.decisionId });
        if (options.failPut) throw new Error('injected reservation transport failure');
        return { kind: 'reserved', reservationRevision: 1, reservation: { decisionId: put.decisionId, ...put.body } };
      },
      deleteAssignmentReservation: async (del: any) => {
        events.push({ delete: del.decisionId });
        return { kind: 'ok', reservationRevision: 1, deleted: true };
      },
    } as any,
  });
}

function groupState() {
  return {
    serviceId, groupId: 'g', activeProfileId: 'a', generation: 1, runtimeStateRevision: 0, lastSwitchAt: null, lastSwitchReason: null,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax', autoSwitch: true }),
    members: ['a', 'b', 'c'].map((profileId, index) => ({ profileId, enabled: true, priority: index, createdAtMs: index })),
    memberStatesByProfileId: new Map(['a', 'b', 'c'].map((profileId) => [profileId, { quotaSnapshot: { capturedAtMs: NOW - 1, effectiveRemainingPercent: 60 } }])),
    memberHolds: NO_CONNECTED_SERVICE_MEMBER_HOLDS,
  };
}

const ids = (ledger: PerSessionAssignmentLedger) => ledger.list().map((entry) => entry.decisionId).sort();

describe('replacement chain (HPI-01, amended T20)', () => {
  it('keeps a failed first-spawn target through its old runner\'s proved retirement until the successor settles', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'first-b', { origin: 'spawn' });
    await ledger.recordRunner('first-b', { pid: 123, processInstanceFingerprint: 'old-runner' }, 1);
    const state = groupState();
    let next: any = null;
    const coordinator = new PerSessionFailoverCoordinator({
      loadGroup: async () => state as any,
      buildState: async () => state as any,
      switchSharedGroup: async () => { throw new Error('unexpected shared switch'); },
      recordFailure: async () => {},
      readSessionBinding: () => ({
        subjectId: 'subject', currentProfileId: null,
        materializedAssignment: { profileId: 'b', decisionId: 'first-b', reason: 'initial_sampled', materializedAtMs: 1 } as any,
      }),
      applyAssignment: async (assignment) => { next = assignment.binding; return { ok: true, action: 'restart_requested' } as any; },
      ledger,
      releaseUnappliedDecision: async (decisionId) => { await ledger.remove(decisionId); },
      ownerMachineId: 'm',
      reservationApi: null,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      deadlineMs: 30_000,
      uniformSample: () => 0.9,
    });
    await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'b' });
    const successorId: string = next.materializedAssignment.decisionId;
    expect(ledger.get(successorId)?.replacesDecisionIds).toEqual(['first-b']);

    // The old runner retired (proved absent); no runner carries the successor yet.
    const events: Event[] = [];
    await runtimeFor(ledger, () => [], { events, presence: 'absent' }).tick();
    expect(ids(ledger)).toEqual(['first-b', successorId].sort());
    expect(events).not.toContainEqual({ delete: 'first-b' });

    // The successor's runner starts and adoption is proved: the whole chain settles.
    const adopted = { assignment: 'per_session', profileId: next.materializedAssignment.profileId, decisionId: successorId, reason: 'failover', appliedAtMs: NOW };
    await runtimeFor(ledger, () => launchedWith({ member: adopted }), { events, presence: 'absent' }).tick();
    expect(ids(ledger)).toEqual([successorId]);
    expect(events).toContainEqual({ delete: 'first-b' });
  });

  it('completes chain settlement on the next tick after adoption failed at the reservation update', async () => {
    const { path, ledger } = await freshLedger();
    await record(ledger, 'older-a');
    await record(ledger, 'failed-b', { replaces: ['older-a'] });
    await record(ledger, 'new-c', { profileId: 'c', replaces: ['failed-b'] });
    await record(ledger, 'newer-d', { profileId: 'a' });
    await record(ledger, 'peer', { sessionId: 'other' });
    const adopted = { assignment: 'per_session', profileId: 'c', decisionId: 'new-c', reason: 'failover', appliedAtMs: NOW };
    const sessions = () => launchedWith({ member: adopted });
    const events: Event[] = [];
    // Inject the failure after the ledger write but before settlement completes.
    await ledger.markApplied('new-c', NOW);
    await expect(runtimeFor(ledger, sessions, { events, failPut: true }).markAdopted({ serviceId, groupId: 'g', decisionId: 'new-c', profileId: 'c' }))
      .rejects.toThrow('injected');

    const restartedLedger = new PerSessionAssignmentLedger(path);
    await runtimeFor(restartedLedger, sessions, { events }).tick();
    expect(ids(restartedLedger)).toEqual(['new-c', 'newer-d', 'peer']);
  });

  it('settles the chain on a tick after a crash between metadata commit and the adoption callback', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'failed-b');
    await record(ledger, 'new-c', { profileId: 'c', replaces: ['failed-b'] });
    const adopted = { assignment: 'per_session', profileId: 'c', decisionId: 'new-c', reason: 'failover', appliedAtMs: NOW };
    // The runner was launched for pending c; its committed metadata records c adopted.
    const launchedPending = { materializedAssignment: { profileId: 'c', decisionId: 'new-c', reason: 'failover', materializedAtMs: 2 } };
    await runtimeFor(ledger, () => launchedWith(launchedPending, { member: adopted })).tick();
    expect(ledger.get('new-c')?.state).toBe('applied');
    expect(ids(ledger)).toEqual(['new-c']);
  });
});

describe('launch-attempt custody across a daemon restart (HPI-02)', () => {
  it('refuses to redraw beside an uncertain no-pid launch when its target turns ineligible on replay', async () => {
    const { path, ledger } = await freshLedger();
    await record(ledger, 'uncertain-b', { origin: 'spawn' });
    const custody = runtimeFor(ledger, () => []).createSpawnCustody();
    custody.claim(['uncertain-b']);
    await custody.markLaunchAttempted();
    await custody.releaseIfNeverLaunched();
    expect(ledger.get('uncertain-b')).not.toBeNull();

    const events: Event[] = [];
    const restartedLedger = new PerSessionAssignmentLedger(path);
    const restarted = runtimeFor(restartedLedger, () => [], { events });
    const state = groupState();
    state.members = state.members.map((member) => (member.profileId === 'b' ? { ...member, enabled: false } : member));
    const replay = resolvePerSessionGroupMemberForSpawn({
      serviceId, groupId: 'g', selection: { kind: 'group', serviceId, groupId: 'g' } as any, state: state as any, sessionId: 'subject',
      quotaFreshnessMs: 300_000, nowMs: () => NOW, deadlineAtMs: NOW + 30_000, requiredModelIds: [], deps: restarted.spawnDeps,
    });
    await expect(replay).rejects.toMatchObject({ code: 'per_session_launch_unsettled' });
    await expect(replay).rejects.toBeInstanceOf(ConnectedServicePerSessionSpawnError);
    expect(ids(restartedLedger)).toEqual(['uncertain-b']);
    expect(events).toEqual([]);
  });

  it('control: a definite never-entered launch is still released and the replay draws again', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'never-b', { origin: 'spawn' });
    const runtime = runtimeFor(ledger, () => []);
    const state = groupState();
    state.members = state.members.map((member) => (member.profileId === 'b' ? { ...member, enabled: false } : member));
    const result = await resolvePerSessionGroupMemberForSpawn({
      serviceId, groupId: 'g', selection: { kind: 'group', serviceId, groupId: 'g' } as any, state: state as any, sessionId: 'subject',
      quotaFreshnessMs: 300_000, nowMs: () => NOW, deadlineAtMs: NOW + 30_000, requiredModelIds: [], deps: runtime.spawnDeps,
    });
    expect(result.profileId).not.toBe('b');
    expect(ledger.get('never-b')).toBeNull();
  });
});

describe('proved shared conversion survives a crash after the metadata commit (HPI-17)', () => {
  const launchedForGroupHome = {
    member: { assignment: 'per_session', profileId: 'b', decisionId: 'owned-b', reason: 'initial_sampled', appliedAtMs: 1 },
    materializedAssignment: { profileId: 'a', decisionId: 'convert-a', reason: 'policy_conversion', home: 'group', materializedAtMs: 2 },
  };

  async function seeded() {
    const { ledger } = await freshLedger();
    await record(ledger, 'owned-b');
    await ledger.markApplied('owned-b', 1);
    await record(ledger, 'failed', { profileId: 'c' });
    await record(ledger, 'replacement', { profileId: 'a', replaces: ['failed'] });
    await record(ledger, 'peer', { sessionId: 'other' });
    return ledger;
  }

  it('settles every decision of the subject from the committed metadata on the next tick, keeping a peer', async () => {
    const ledger = await seeded();
    await runtimeFor(ledger, () => launchedWith(launchedForGroupHome, { appliedProfileId: 'a' })).tick();
    expect(ids(ledger)).toEqual(['peer']);
  });

  it.each([
    ['launch bindings only, no committed metadata', launchedWith(launchedForGroupHome)],
    ['a wrong observed account', launchedWith(launchedForGroupHome, { appliedProfileId: 'c' })],
    ['a runner launched for a per-session member', launchedWith({ member: launchedForGroupHome.member }, { appliedProfileId: 'a' })],
    ['committed metadata still carrying the pending conversion', launchedWith(launchedForGroupHome, { ...launchedForGroupHome, appliedProfileId: 'b' })],
  ])('proves nothing from %s', async (_label, sessions) => {
    const ledger = await seeded();
    await runtimeFor(ledger, () => sessions).tick();
    expect(ids(ledger)).toEqual(expect.arrayContaining(['failed', 'replacement', 'peer']));
  });
});

describe('reservation release at the first fresh snapshot after first provider activity (HPI-20, spec A.3)', () => {
  const applied = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };

  async function appliedSession() {
    const { ledger } = await freshLedger();
    await record(ledger, 'applied-a', { profileId: 'a', origin: 'spawn' });
    await ledger.markApplied('applied-a', 1);
    return ledger;
  }

  it('releases once, after activity and a snapshot captured later, and stops counting and renewing it', async () => {
    const ledger = await appliedSession();
    const sessions = () => launchedWith({ member: applied });
    let capturedAt = NOW + 50;
    const events: Event[] = [];
    const runtime = runtimeFor(ledger, sessions, { events, snapshotCapturedAt: (profileId) => (profileId === 'a' ? capturedAt : null) });

    await runtime.recordProviderActivity({ decisions: collectPerSessionLiveDecisions(sessions()), observedAtMs: NOW + 100 });
    await runtime.tick();
    expect(events).toEqual([{ put: 'applied-a' }]); // snapshot predates the activity

    capturedAt = NOW + 200;
    await runtime.tick();
    await runtime.tick();
    expect(events).toEqual([{ put: 'applied-a' }, { delete: 'applied-a' }]);
    expect(ledger.get('applied-a')).toMatchObject({ state: 'applied', firstProviderActivityAtMs: NOW + 100, reservationReleasedAtMs: NOW });
    expect(ledger.localCounts(serviceId, 'g').get('a')).toBeUndefined();

    // Later activity does not move the first-activity time.
    await runtime.recordProviderActivity({ decisions: collectPerSessionLiveDecisions(sessions()), observedAtMs: NOW + 300 });
    expect(ledger.get('applied-a')?.firstProviderActivityAtMs).toBe(NOW + 100);
  });

  it.each([
    ['a fresh snapshot without any provider activity', async () => {}, (profileId: string) => (profileId === 'a' ? NOW + 500 : null)],
    ['activity followed only by another member\'s fresh snapshot', 'activity', (profileId: string) => (profileId === 'b' ? NOW + 500 : NOW - 1)],
    ['another session\'s activity', 'other-session', () => NOW + 500],
    ['activity while the decision is only a pending target', 'pending', () => NOW + 500],
  ] as const)('does not release on %s', async (_label, activity, snapshot) => {
    const ledger = await appliedSession();
    const sessions = () => launchedWith({ member: applied });
    const events: Event[] = [];
    const runtime = runtimeFor(ledger, sessions, { events, snapshotCapturedAt: snapshot });
    if (activity === 'activity') {
      await runtime.recordProviderActivity({ decisions: collectPerSessionLiveDecisions(sessions()), observedAtMs: NOW + 100 });
    } else if (activity === 'other-session') {
      const other = [{ happySessionId: 'other', spawnOptions: { connectedServices: groupBindings({ member: { ...applied, decisionId: 'other-a' } }) } }];
      await runtime.recordProviderActivity({ decisions: collectPerSessionLiveDecisions(other), observedAtMs: NOW + 100 });
    } else if (activity === 'pending') {
      await runtime.recordProviderActivity({
        decisions: collectPerSessionLiveDecisions(launchedWith({ materializedAssignment: { profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', materializedAtMs: 1 } })),
        observedAtMs: NOW + 100,
      });
    }
    await runtime.tick();
    expect(events).toEqual([{ put: 'applied-a' }]);
    expect(ledger.get('applied-a')?.reservationReleasedAtMs).toBeUndefined();
  });
});

describe('round-5 custody and proof boundaries', () => {
  it('keeps an unadopted successor and its failed predecessor when the successor\'s runner is gone too (HPI-01)', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'first-b', { origin: 'spawn' });
    await ledger.recordRunner('first-b', { pid: 1 }, 1);
    await record(ledger, 'successor-c', { profileId: 'c', replaces: ['first-b'] });
    await ledger.recordRunner('successor-c', { pid: 2 }, 1);
    const events: Event[] = [];
    const runtime = runtimeFor(ledger, () => [], { events, presence: 'absent' });
    await runtime.tick();
    await runtime.tick();
    expect(ids(ledger)).toEqual(['first-b', 'successor-c']);
    expect(events.filter((event) => 'delete' in event)).toEqual([]);

    // The session's observed retirement is the terminal proof that releases the whole chain.
    await runtime.releaseForRetiredSubjects(['subject']);
    expect(ids(ledger)).toEqual([]);
  });

  it('control: a lone spawn decision whose recorded runner is gone is still released', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'only-b', { origin: 'spawn' });
    await ledger.recordRunner('only-b', { pid: 1 }, 1);
    await runtimeFor(ledger, () => [], { presence: 'absent' }).tick();
    expect(ids(ledger)).toEqual([]);
  });

  it('never treats an ordinary shared session as a conversion of its first new per-session decision (HPI-23)', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'first-per-session', { profileId: 'c', decidedAtMs: NOW });
    const shared = launchedWith({ appliedProfileId: 'a' }, { appliedProfileId: 'a' });
    await runtimeFor(ledger, () => shared).tick();
    expect(ids(ledger)).toEqual(['first-per-session']);
  });

  it('a real earlier conversion retires only decisions made up to it, never a later one (HPI-23)', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'before-conversion', { decidedAtMs: 1 });
    await record(ledger, 'after-conversion', { profileId: 'c', decidedAtMs: NOW });
    const converted = launchedWith(
      { materializedAssignment: { profileId: 'a', decisionId: 'convert-a', reason: 'policy_conversion', home: 'group', materializedAtMs: 2 } },
      { appliedProfileId: 'a' },
    );
    await runtimeFor(ledger, () => converted).tick();
    expect(ids(ledger)).toEqual(['after-conversion']);
  });
});

describe('recovery replay and redraw (HPI-21, HPI-26)', () => {
  function coordinatorFor(ledger: PerSessionAssignmentLedger, options: Readonly<{
    state: () => ReturnType<typeof groupState>;
    binding: () => any;
    onPut?: (profileId: string) => void;
    applied?: string[];
  }>) {
    return new PerSessionFailoverCoordinator({
      loadGroup: async () => options.state() as any,
      buildState: async () => options.state() as any,
      switchSharedGroup: async () => { throw new Error('unexpected shared switch'); },
      recordFailure: async () => {},
      readSessionBinding: options.binding,
      applyAssignment: async (assignment) => { options.applied?.push(assignment.profileId); return { ok: true, action: 'metadata_updated' } as any; },
      ledger,
      releaseUnappliedDecision: async (decisionId) => { await ledger.remove(decisionId); },
      ownerMachineId: 'm',
      reservationApi: {
        listAssignmentReservations: async () => ({ kind: 'ok', reservationRevision: 0, reservations: [] }),
        putAssignmentReservation: async (put: any) => {
          options.onPut?.(put.body.profileId);
          return { kind: 'reserved', reservationRevision: 1, reservation: { decisionId: put.decisionId, ...put.body, createdAtMs: NOW } };
        },
        deleteAssignmentReservation: async () => ({ kind: 'ok', reservationRevision: 2, deleted: true }),
      } as any,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      deadlineMs: 30_000,
      uniformSample: () => 0,
    });
  }

  it.each([
    ['requests the deferred restart again when no runner was ever started with the committed decision', null, 'spawn_next_turn'],
    ['requests it again when the recorded launch is not the current runner', 77, 'spawn_next_turn'],
    ['waits for adoption once the current runner is the one started with it', 123, 'restart_resume'],
  ] as const)('a durable retry %s', async (_label, launchedPid, mode) => {
    const { ledger } = await freshLedger();
    await record(ledger, 'replay-c', { profileId: 'c' });
    if (launchedPid !== null) await ledger.recordLaunchedRunner(['replay-c'], { pid: launchedPid }, 2);
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { profileId: 'c', decisionId: 'replay-c', reason: 'failover', materializedAtMs: 2 };
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: groupState,
      // Metadata and (mutable) respawn options both already name the target; only the ledger's launch
      // record says whether a runner was started with it.
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 123 } }),
      applied,
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'c', mode });
    expect(applied).toEqual([]);
    expect(ids(ledger)).toEqual(['replay-c']);
  });

  it.each([
    ['a runner launched with the target, though its launch record was never written (HPI-31)', ['applied-a', 'replay-c'], 'restart_resume'],
    ['the reporting runner, launched before the target existed', ['applied-a'], 'spawn_next_turn'],
    ['a runner whose launch was not observed (reattached) and has no launch record', undefined, 'spawn_next_turn'],
  ] as const)('replay judges the restart performed from the launch the spawn site recorded: %s', async (_label, launchedIds, mode) => {
    const { ledger } = await freshLedger();
    await record(ledger, 'replay-c', { profileId: 'c' });
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { profileId: 'c', decisionId: 'replay-c', reason: 'failover', materializedAtMs: 2 };
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: groupState,
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 123 }, ...(launchedIds ? { runnerLaunchedDecisionIds: launchedIds } : {}) }),
      applied,
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'c', mode });
    expect(applied).toEqual([]);
  });

  it.each([
    ['performed: the current runner was launched with the conversion target', ['applied-a', 'convert-b'], 'restart_resume'],
    ['definitely not performed: the old runner still runs', ['applied-a'], 'spawn_next_turn'],
  ] as const)('a replayed shared conversion is %s (HPI-32)', async (_label, launchedIds, mode) => {
    const { ledger } = await freshLedger();
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { home: 'group', profileId: 'b', decisionId: 'convert-b', reason: 'policy_rollback', materializedAtMs: 2 };
    const shared = () => ({ ...groupState(), policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'least_limited', autoSwitch: true }) });
    const coordinator = coordinatorFor(ledger, {
      state: shared,
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 456 }, runnerLaunchedDecisionIds: launchedIds }),
      applied: [],
    });
    // The durable retry replays the old runner's original report on A.
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'b', mode });
  });

  it.each([
    ['refused while its launch is unperformed', ['applied-a'], { status: 'generation_apply_failed', activeProfileId: 'b' }],
    ['left awaiting adoption once its launch is performed', ['applied-a', 'convert-b'], { status: 'switched', activeProfileId: 'b', mode: 'restart_resume' }],
  ] as const)('a replayed shared conversion onto a held member is %s (HPI-45)', async (_label, launchedIds, expected) => {
    const { ledger } = await freshLedger();
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { home: 'group', profileId: 'b', decisionId: 'convert-b', reason: 'policy_rollback', materializedAtMs: 2 };
    const shared = () => ({
      ...groupState(),
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'least_limited', autoSwitch: true }),
      memberHolds: { status: 'readable', holdsByProfileId: new Map([['b', {
        serviceId, profileId: 'b', reason: 'test', source: 'test', heldAtMs: 1, lifetime: { kind: 'until_released' as const },
      }]]) },
    }) as unknown as ReturnType<typeof groupState>;
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: shared,
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 456 }, runnerLaunchedDecisionIds: launchedIds }),
      applied,
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject(expected);
    // Neither case rewrites the committed conversion or the proved member.
    expect(applied).toEqual([]);
  });

  it.each([
    ['missing from the ledger', false],
    ['rebuilt from live bindings as a spawn-origin entry', true],
  ] as const)('resumes the committed pending target under its own decision when it is %s (HPI-39)', async (_label, rebuilt) => {
    const { ledger } = await freshLedger();
    if (rebuilt) await record(ledger, 'pending-b', { profileId: 'b', origin: 'spawn' });
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { profileId: 'b', decisionId: 'pending-b', reason: 'failover', materializedAtMs: 2 };
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: groupState,
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 123 }, runnerLaunchedDecisionIds: ['applied-a', 'pending-b'] }),
      applied,
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'b', mode: 'restart_resume' });
    expect(applied).toEqual([]);
    expect(ids(ledger)).toEqual(rebuilt ? ['pending-b'] : []);
  });

  it.each([
    ['missing, before its launch', false, false],
    ['missing, after its launch', false, true],
    ['rebuilt, before its launch', true, false],
    ['rebuilt, after its launch', true, true],
  ] as const)('replaces a committed pending target that is no longer eligible when its record is %s (HPI-42)', async (_label, rebuilt, launched) => {
    const { ledger } = await freshLedger();
    if (rebuilt) await record(ledger, 'pending-b', { profileId: 'b', origin: 'spawn' });
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { profileId: 'b', decisionId: 'pending-b', reason: 'failover', materializedAtMs: 2 };
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: () => {
        const state = groupState();
        state.members = state.members.map((m) => ({ ...m, enabled: m.profileId !== 'b' }));
        return state;
      },
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, materializedAssignment: pending, runner: { pid: 123 },
        runnerLaunchedDecisionIds: launched ? ['applied-a', 'pending-b'] : ['applied-a'] }),
      applied,
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'c', mode: 'spawn_next_turn' });
    expect(applied).toEqual(['c']);
    const replacement = ledger.list().find((entry) => entry.proposal.profileId === 'c');
    expect(replacement?.replacesDecisionIds).toEqual(['pending-b']);
    // The superseded target keeps custody until its replacement is adopted.
    if (rebuilt) expect(ledger.get('pending-b')).toBeDefined();
  });

  it('records the started runner on every decision the launch carries, owned or reused', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'reused-c', { profileId: 'c' });
    await record(ledger, 'owned-d', { profileId: 'a', origin: 'spawn' });
    const custody = runtimeFor(ledger, () => []).createSpawnCustody();
    custody.claim(['owned-d']);
    custody.claimLaunched(['reused-c', 'owned-d']);
    await custody.markLaunchAttempted();
    await custody.recordRunner({ pid: 55 });
    expect(ledger.get('reused-c')).toMatchObject({ launchedRunner: { pid: 55 } });
    expect(ledger.get('reused-c')?.runner).toBeUndefined();
    expect(ledger.get('owned-d')).toMatchObject({ launchedRunner: { pid: 55 }, runner: { pid: 55 } });
  });

  it('redraws from the fresh state that refused the target, reaching a member added meanwhile', async () => {
    const { ledger } = await freshLedger();
    let state = groupState();
    state.members = state.members.filter((member) => member.profileId !== 'c');
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const applied: string[] = [];
    const coordinator = coordinatorFor(ledger, {
      state: () => state,
      binding: () => ({ subjectId: 'subject', currentProfileId: 'a', member, runner: { pid: 123 } }),
      applied,
      // While B's reservation is acknowledged, the group replaces B with a healthy C.
      onPut: (profileId) => {
        if (profileId !== 'b') return;
        const fresh = groupState();
        fresh.members = fresh.members.filter((candidate) => candidate.profileId !== 'b');
        state = fresh;
      },
    });
    const result = await coordinator.switchAfterClassifiedFailure({ sessionId: 'subject', serviceId, groupId: 'g', reason: 'usage_limit', observedProfileId: 'a' });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'c' });
    expect(applied).toEqual(['c']);
    expect(ledger.list().map((entry) => entry.proposal.profileId)).toEqual(['c']);
  });
});

describe('offline-ended recovery retention (HPI-28)', () => {
  async function appliedRecovery(ledger: PerSessionAssignmentLedger, decisionId: string, pid: number, sessionId = 'subject') {
    await record(ledger, decisionId, { sessionId });
    await ledger.markApplied(decisionId, 1);
    // A restart-resume launch records the runner only as launched, never as this decision's own spawn.
    await ledger.recordLaunchedRunner([decisionId], { pid }, 1);
  }

  it('releases an applied recovery decision whose launched runner is proved gone and nothing for the subject is pending', async () => {
    const { ledger } = await freshLedger();
    await appliedRecovery(ledger, 'recovered-b', 9);
    const events: Event[] = [];
    await runtimeFor(ledger, () => [], { events, presence: 'absent' }).tick();
    expect(ids(ledger)).toEqual([]);
    expect(events).toContainEqual({ delete: 'recovered-b' });
  });

  it('control: keeps it while a recovery for the same subject is still pending, and while runner presence is unknown', async () => {
    const { ledger } = await freshLedger();
    await appliedRecovery(ledger, 'recovered-b', 9);
    await record(ledger, 'pending-c', { profileId: 'c' });
    await runtimeFor(ledger, () => [], { presence: 'absent' }).tick();
    expect(ids(ledger)).toContain('recovered-b');

    const { ledger: unknownLedger } = await freshLedger();
    await appliedRecovery(unknownLedger, 'recovered-b', 9);
    await runtimeFor(unknownLedger, () => [], { presence: 'unknown' }).tick();
    expect(ids(unknownLedger)).toEqual(['recovered-b']);
  });

  it('releases the subjects whose recorded or launched runner ended while the daemon was down, and nothing else', async () => {
    const { ledger } = await freshLedger();
    await appliedRecovery(ledger, 'recovered-b', 9);
    await record(ledger, 'spawned-c', { profileId: 'c', origin: 'spawn', sessionId: 'other' });
    await ledger.recordRunner('spawned-c', { pid: 10 }, 1);
    await record(ledger, 'alive-d', { profileId: 'a', origin: 'spawn', sessionId: 'alive' });
    await ledger.recordRunner('alive-d', { pid: 11 }, 1);
    const runtime = runtimeFor(ledger, () => []);
    await runtime.releaseForEndedRunnerPids([]);
    expect(ids(ledger)).toEqual(['alive-d', 'recovered-b', 'spawned-c']);
    await runtime.releaseForEndedRunnerPids([9, 10, 404]);
    expect(ids(ledger)).toEqual(['alive-d']);
  });

  it('never retires an unfinished recovery chain because its old runner ended offline (HPI-01 kept)', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'first-b', { origin: 'spawn' });
    await ledger.recordRunner('first-b', { pid: 1 }, 1);
    await record(ledger, 'successor-c', { profileId: 'c', replaces: ['first-b'] });
    const events: Event[] = [];
    await runtimeFor(ledger, () => [], { events }).releaseForEndedRunnerPids([1]);
    expect(ids(ledger)).toEqual(['first-b', 'successor-c']);
    expect(events).toEqual([]);
  });
});

describe('runner identity of reused launches and rebuilt entries (HPI-33)', () => {
  it('a rebuilt entry keeps the live runner carrying it, so its next offline end releases it once', async () => {
    const { ledger } = await freshLedger();
    const member = { assignment: 'per_session', profileId: 'b', decisionId: 'resumed-d', reason: 'initial_sampled', appliedAtMs: 1 };
    let sessions: TrackedFixture[] = [{
      happySessionId: 'subject',
      pid: 200, processInstanceFingerprint: 'fp-200',
      spawnOptions: { connectedServices: groupBindings({ member }) },
      happySessionMetadataFromLocalWebhook: { connectedServices: groupBindings({ member }) },
    }];
    const events: Event[] = [];
    const runtime = runtimeFor(ledger, () => sessions, { events, presence: 'present' });
    await runtime.tick();
    expect(ledger.get('resumed-d')).toMatchObject({ state: 'applied', launchedRunner: { pid: 200, processInstanceFingerprint: 'fp-200' } });

    // The resumed session ends while the daemon is down; startup reports its dead marker.
    sessions = [];
    await runtime.releaseForEndedRunnerPids([200]);
    expect(ids(ledger)).toEqual([]);
    expect(events.filter((event) => 'delete' in event)).toEqual([{ delete: 'resumed-d' }]);
  });

  it('a healthy live tick completes a rebuild cut before its runner write, so the offline end releases once (HPI-36)', async () => {
    const { ledger } = await freshLedger();
    // Durable state left by the cut: proposal and applied written, runner never recorded.
    await record(ledger, 'resumed-d', { origin: 'spawn' });
    await ledger.markApplied('resumed-d', 1);
    const member = { assignment: 'per_session', profileId: 'b', decisionId: 'resumed-d', reason: 'initial_sampled', appliedAtMs: 1 };
    let sessions: TrackedFixture[] = [{
      happySessionId: 'subject', pid: 200, processInstanceFingerprint: 'fp-200',
      spawnOptions: { connectedServices: groupBindings({ member }) },
      happySessionMetadataFromLocalWebhook: { connectedServices: groupBindings({ member }) },
    }];
    const events: Event[] = [];
    const runtime = runtimeFor(ledger, () => sessions, { events, presence: 'present' });
    await runtime.tick();
    expect(ledger.get('resumed-d')).toMatchObject({ launchedRunner: { pid: 200, processInstanceFingerprint: 'fp-200' } });
    await runtime.tick();
    sessions = [];
    await runtime.releaseForEndedRunnerPids([200]);
    expect(ids(ledger)).toEqual([]);
    expect(events.filter((event) => 'delete' in event)).toEqual([{ delete: 'resumed-d' }]);
  });

  it('never credits the current runner as the launch of a pending target its bindings already name (HPI-21 kept)', async () => {
    const { ledger } = await freshLedger();
    const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 };
    const pending = { profileId: 'c', decisionId: 'pending-c', reason: 'failover', materializedAtMs: 2 };
    let sessions: TrackedFixture[] = [{
      happySessionId: 'subject', pid: 123,
      spawnOptions: { connectedServices: groupBindings({ member, materializedAssignment: pending }) },
      happySessionMetadataFromLocalWebhook: { connectedServices: groupBindings({ member, materializedAssignment: pending }) },
    }];
    const runtime = runtimeFor(ledger, () => sessions, { presence: 'present' });
    await runtime.tick();
    await runtime.tick();
    expect(ledger.get('pending-c')?.launchedRunner).toBeUndefined();
    // Recorded only as its carrier: not definitely pre-launch, and retired when that runner ends offline.
    expect(ledger.get('pending-c')?.carrierRunner).toEqual({ pid: 123 });
    expect(ledger.get('applied-a')).toMatchObject({ launchedRunner: { pid: 123 } });
    expect(await runtime.releaseAfterDefinitePreLaunchFailure('pending-c')).toBe(false);
    sessions = [];
    await runtime.releaseForEndedRunnerPids([123]);
    expect(ids(ledger)).toEqual([]);
  });

  it('an earlier runner\'s offline end never retires a resumed launch not yet recorded', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'old-b', { origin: 'spawn' });
    await ledger.recordRunner('old-b', { pid: 100 }, 1);
    await ledger.markApplied('old-b', 1);
    await record(ledger, 'resumed-c', { profileId: 'c', origin: 'spawn' });
    await ledger.markLaunchAttempted(['resumed-c'], 2);
    await runtimeFor(ledger, () => []).releaseForEndedRunnerPids([100]);
    expect(ids(ledger)).toEqual(['old-b', 'resumed-c']);
  });

  it('a later launch, not the decision\'s first runner, decides its retirement', async () => {
    const { ledger } = await freshLedger();
    await record(ledger, 'spawned-b', { origin: 'spawn' });
    await ledger.recordRunner('spawned-b', { pid: 100 }, 1);
    await ledger.markApplied('spawned-b', 1);
    await ledger.recordLaunchedRunner(['spawned-b'], { pid: 200 }, 2);
    const runtime = runtimeFor(ledger, () => []);
    await runtime.releaseForEndedRunnerPids([100]);
    expect(ids(ledger)).toEqual(['spawned-b']);
    await runtime.releaseForEndedRunnerPids([200]);
    expect(ids(ledger)).toEqual([]);
  });
});
