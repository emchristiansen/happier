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
  happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
  spawnOptions: Readonly<{ connectedServices: unknown }>;
}>;

function proposal(decisionId: string, profileId: string): PerSessionAssignmentProposal {
  return {
    decisionId, profileId, proposalRevision: 1, reason: 'failover', fromProfileId: 'a', temperature: 1.5, offsetPercent: 10,
    probability: 1, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 0,
  };
}

async function freshLedger() {
  const path = join(await mkdtemp(join(tmpdir(), 'per-session-custody-')), 'ledger.json');
  return { path, ledger: new PerSessionAssignmentLedger(path) };
}

async function record(
  ledger: PerSessionAssignmentLedger,
  decisionId: string,
  options: Readonly<{ profileId?: string; origin?: 'spawn' | 'recovery'; replaces?: string[]; sessionId?: string }> = {},
) {
  await ledger.recordProposal({
    decisionId,
    sessionId: options.sessionId ?? 'subject',
    serviceId,
    groupId: 'g',
    origin: options.origin ?? 'recovery',
    proposal: proposal(decisionId, options.profileId ?? 'b'),
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
  snapshotCapturedAt?: (profileId: string) => number | null;
}> = {}) {
  const events = options.events ?? [];
  return new PerSessionAssignmentRuntime({
    ledger,
    ownerMachineId: 'm',
    nowMs: options.nowMs ?? (() => NOW),
    listLiveDecisions: () => collectPerSessionLiveDecisions(sessions()),
    listLiveSubjectIds: () => collectPerSessionLiveSubjectIds(sessions()),
    listProvedSharedConversions: () => collectPerSessionProvedSharedConversions(sessions()),
    ...(options.snapshotCapturedAt ? { readMemberSnapshotCapturedAtMs: ({ profileId }: { profileId: string }) => options.snapshotCapturedAt!(profileId) } : {}),
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
