import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { resolveConnectedServiceGroupMemberProviderAccountResolution } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';
import {
  buildRuntimeAuthAttemptTransitionEvent,
  createRuntimeAuthAttemptAccountJoinJournal,
  foldRuntimeAuthAttemptAccountJoins,
  observeRuntimeAuthRecoveryIntentTransitions,
  type ProviderAccountObservedEvent,
  type ProviderAccountResolution,
  type RuntimeAuthAttemptAccountJoinEvent,
} from './runtimeAuthAttemptAccountJoin';

const SERVICE = 'claude-subscription';

type Intent = Parameters<typeof buildRuntimeAuthAttemptTransitionEvent>[0]['intent'] & { attemptId?: string };

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    sessionId: 's1', serviceId: SERVICE, groupId: 'g', profileId: 'A', status: 'waiting', attemptCount: 0,
    pendingTargetProfileId: null, pendingTargetGeneration: null, terminalReason: null,
    classification: { kind: 'usage_limit', providerReportedOrganizationId: 'org-A', sourceKey: 'turn-7', runtimeIssueFingerprint: 'usage-limit:claude:x' },
    ...overrides,
  };
}

function transition(attemptId: string, persistedAtMs: number, overrides: Partial<Intent> = {}): RuntimeAuthAttemptAccountJoinEvent {
  return buildRuntimeAuthAttemptTransitionEvent({ attemptId, transition: 'working', persistedAtMs, intent: intent(overrides) });
}

function observed(
  observedAtMs: number,
  resolution: ProviderAccountResolution,
  overrides: Partial<{ nativeSessionId: string; sessionId: string; adoption: ProviderAccountObservedEvent['adoption'] }> = {},
): ProviderAccountObservedEvent {
  return {
    v: 1, kind: 'provider_account_observed', sessionId: overrides.sessionId ?? 's1', serviceId: SERVICE, groupId: 'g',
    nativeSessionId: overrides.nativeSessionId ?? 'native-1', providerOrganizationId: 'org', resolution,
    adoption: overrides.adoption ?? (resolution.kind === 'unique_member' ? 'adopted' : 'not_unique_member'), observedAtMs,
  };
}

function proof(
  attemptId: string, proofKind: string, observedAtMs: number | null, statusAfter = 'recovered',
  turnOwnership: 'exact_turn' | 'unverified_turn' | null = 'exact_turn',
): RuntimeAuthAttemptAccountJoinEvent {
  return {
    v: 1, kind: 'provider_outcome_proof', sessionId: 's1', attemptId, expectedAttemptId: attemptId, proofKind, observedAtMs,
    turnOwnership, statusBefore: 'resumed_awaiting_proof', statusAfter, attemptIdAfter: attemptId, persistedAtMs: (observedAtMs ?? 0) + 1,
  };
}

const member = (profileId: string): ProviderAccountResolution => ({ kind: 'unique_member', profileId });

/**
 * requested@start → working (checking) @start+10 → applied (resumed) @start+20 → optional recovered.
 * The application window is [start+10, start+20): the switch happened somewhere inside it.
 */
function appliedAttempt(attemptId: string, startMs: number, target = 'B', recovered = false, generation = 2): RuntimeAuthAttemptAccountJoinEvent[] {
  return [
    transition(attemptId, startMs),
    transition(attemptId, startMs + 10, { status: 'checking' }),
    transition(attemptId, startMs + 20, { status: 'resumed_awaiting_proof', pendingTargetProfileId: target, pendingTargetGeneration: generation }),
    ...(recovered ? [transition(attemptId, startMs + 30, { status: 'recovered', pendingTargetProfileId: target, pendingTargetGeneration: generation })] : []),
  ];
}

const dispositions = (join: { observations: ReadonlyArray<{ disposition: string }> } | undefined) => join!.observations.map((entry) => entry.disposition);

describe('runtime-auth attempt → provider-observed applied account join', () => {
  it('keeps requested, selected, applied, observed, recovered and useful distinct and confirms a matching account', () => {
    const [join1] = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100, 'B', true), observed(125, member('B')), proof('a1', 'provider_activity', 126),
    ]);
    expect(join1).toMatchObject({
      attemptId: 'a1',
      requested: { persistedAtMs: 100, failedProfileId: 'A', failureKind: 'usage_limit', failedRequestProviderOrganizationId: 'org-A', sourceKey: 'turn-7' },
      selected: [{ profileId: 'B', generation: 2, persistedAtMs: 120 }],
      materialized: 'not_separately_evidenced',
      applications: [{ index: 0, profileId: 'B', generation: 2, windowStartMs: 110, persistedAtMs: 120, verdict: 'confirmed', countedNativeSessionIds: ['native-1'] }],
      schedulerRecovered: { persistedAtMs: 130, proofKinds: ['provider_activity'] },
      usefulContinuation: { kind: 'provider_activity', observedAtMs: 126, applicationIndex: 0 },
      verdict: 'confirmed',
      latestStatus: 'recovered',
    });
    expect(join1!.transitions.map((event) => event.status)).toEqual(['waiting', 'checking', 'resumed_awaiting_proof', 'recovered']);
  });

  it('does not treat selection or a switch announcement as application or observation', () => {
    const [selectedOnly] = foldRuntimeAuthAttemptAccountJoins([
      transition('a1', 100), transition('a1', 110, { status: 'checking', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
    ]);
    expect(selectedOnly).toMatchObject({ applications: [], verdict: 'awaiting_application', usefulContinuation: { kind: 'not_witnessed' } });
    const [appliedOnly] = foldRuntimeAuthAttemptAccountJoins(appliedAttempt('a1', 100));
    expect(appliedOnly).toMatchObject({ verdict: 'applied_awaiting_observation', schedulerRecovered: null });
  });

  it('JL-03: quota freshness recovers the attempt but is not useful continuation', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100, 'B', true), proof('a1', 'quota_probe_fresh', 129),
    ]);
    expect(joined).toMatchObject({
      schedulerRecovered: { persistedAtMs: 130, proofKinds: ['quota_probe_fresh'] },
      usefulContinuation: { kind: 'not_witnessed' },
    });
    // A recovered status with no recorded proof says so rather than inventing one.
    const [unrecorded] = foldRuntimeAuthAttemptAccountJoins(appliedAttempt('a1', 100, 'B', true));
    expect(unrecorded).toMatchObject({ schedulerRecovered: { proofKinds: 'not_recorded' }, usefulContinuation: { kind: 'not_witnessed' } });
  });

  it('JL-03: provider activity of another attempt, or before application, is not this attempt\'s useful continuation', () => {
    const [other] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), proof('a0', 'provider_activity', 125)]);
    expect(other!.usefulContinuation).toEqual({ kind: 'not_witnessed' });
    const [early] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), proof('a1', 'provider_activity', 105)]);
    expect(early!.usefulContinuation).toEqual({ kind: 'not_witnessed' });
    const [inWindow] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), proof('a1', 'provider_activity', 115)]);
    expect(inWindow!.usefulContinuation).toMatchObject({ kind: 'boundary_uncertain', observedAtMs: 115 });
  });

  it('JL-05: post-application activity whose turn was not verified is labelled, not useful', () => {
    for (const turnOwnership of ['unverified_turn', null] as const) {
      const [joined] = foldRuntimeAuthAttemptAccountJoins([
        ...appliedAttempt('a1', 100, 'B', true), proof('a1', 'provider_activity', 126, 'recovered', turnOwnership),
      ]);
      expect(joined).toMatchObject({
        schedulerRecovered: { proofKinds: ['provider_activity'] },
        usefulContinuation: { kind: 'provider_activity_unverified_turn', observedAtMs: 126, applicationIndex: 0 },
      });
    }
  });

  it('reports a provider-observed different account in the same native session as a mismatch, retaining every observation', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100, 'B', true), observed(123, member('B')), observed(124, member('C')),
    ]);
    expect(joined!.verdict).toBe('mismatch');
    expect(joined!.observations.map((entry) => [entry.event.resolution, entry.disposition])).toEqual([
      [member('B'), 'counted'], [member('C'), 'counted'],
    ]);
  });

  it.each([
    ['an organization shared by several members', { kind: 'ambiguous', matchingProfileIds: ['B', 'C'] } as ProviderAccountResolution],
    ['an unreadable member identity', { kind: 'unproven', reason: 'member_identity_unreadable' } as ProviderAccountResolution],
  ])('keeps %s unknown, never confirmed', (_label, resolution) => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), observed(123, resolution, { adoption: 'adopted' })]);
    expect(joined!.verdict).toBe('unknown');
  });

  it('JL-02: an observation inside the application window is boundary-uncertain; a pre-switch one is not counted', () => {
    // Persistence (120) lags application: the provider may emit the new identity at 115.
    const [inWindow] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), observed(115, member('B'))]);
    expect(dispositions(inWindow)).toEqual(['boundary_uncertain']);
    expect(inWindow!.verdict).toBe('boundary_uncertain');
    // Genuine pre-switch negative control: before the attempt even began working.
    const [preSwitch] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), observed(105, member('A'))]);
    expect(dispositions(preSwitch)).toEqual(['before_application']);
    expect(preSwitch!.verdict).toBe('applied_awaiting_observation');
  });

  it('JL-01: reselection within one attempt keeps both application intervals and judges each by its own target', () => {
    const events = [
      ...appliedAttempt('a1', 100, 'B'),
      transition('a1', 200, { status: 'checking', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
      transition('a1', 210, { status: 'resumed_awaiting_proof', pendingTargetProfileId: 'C', pendingTargetGeneration: 3 }),
      observed(215, member('C')),
      // B's earlier observation arrives late; its provider time places it in B's interval.
      observed(150, member('B')),
    ];
    const [joined] = foldRuntimeAuthAttemptAccountJoins(events);
    expect(joined!.applications.map((application) => [application.profileId, application.generation, application.verdict])).toEqual([
      ['B', 2, 'confirmed'], ['C', 3, 'confirmed'],
    ]);
    expect(joined!.verdict).toBe('confirmed');
    expect(joined!.observations.map((entry) => [entry.disposition, entry.applicationIndex])).toEqual([['counted', 1], ['counted', 0]]);
    // A genuinely wrong account after the reselection is still a mismatch of the CURRENT application.
    const [wrong] = foldRuntimeAuthAttemptAccountJoins([...events.slice(0, -2), observed(215, member('B'))]);
    expect(wrong!.applications.map((application) => application.verdict)).toEqual(['applied_awaiting_observation', 'mismatch']);
    expect(wrong!.verdict).toBe('mismatch');
  });

  it('JL-04: disagreeing native sessions are reported as conflicting in either arrival order', () => {
    const older = observed(130, member('B'), { nativeSessionId: 'native-old' });
    const newer = observed(140, member('C'), { nativeSessionId: 'native-new' });
    const [oldFirst] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), older, newer]);
    const [newFirst] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), newer, older]);
    for (const joined of [oldFirst, newFirst]) {
      expect(joined!.verdict).toBe('conflicting_native_sessions');
      expect(joined!.applications[0]!.countedNativeSessionIds).toEqual(['native-new', 'native-old']);
    }
  });

  it('JL-04: an observation the application owner did not adopt is retained but never counted', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100), observed(130, member('C'), { adoption: 'rejected_not_current' }), observed(131, member('B')),
    ]);
    expect(dispositions(joined)).toEqual(['not_adopted', 'counted']);
    expect(joined!.verdict).toBe('confirmed');
  });

  it('attributes observations after a newer attempt applied to that attempt only, keeping retry history', () => {
    const events = [
      ...appliedAttempt('a1', 100, 'B'),
      observed(125, member('B')),
      transition('a1', 130, { status: 'exhausted', terminalReason: 'superseded', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
      ...appliedAttempt('a2', 200, 'C', true, 3),
      observed(225, member('C')),
    ];
    const joins = foldRuntimeAuthAttemptAccountJoins(events);
    const first = joins.find((entry) => entry.attemptId === 'a1')!;
    const second = joins.find((entry) => entry.attemptId === 'a2')!;
    expect(first.verdict).toBe('confirmed');
    expect(first.firstTerminal).toMatchObject({ status: 'exhausted', reason: 'superseded' });
    expect(dispositions(first)).toEqual(['counted', 'superseded_by_newer_attempt']);
    expect(second.verdict).toBe('confirmed');
    expect(dispositions(second)).toEqual(['before_application', 'counted']);
  });

  it('an equal-millisecond application of two attempts claims no exclusive association', () => {
    const joins = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100, 'B'), ...appliedAttempt('a2', 100, 'C', false, 3), observed(125, member('C')),
    ]);
    for (const joined of joins) {
      expect(dispositions(joined)).toEqual(['ambiguous_attempt_tie']);
      expect(joined.verdict).toBe('boundary_uncertain');
    }
  });

  it('reports the first terminal and the current status separately after exhausted → recovered', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([
      ...appliedAttempt('a1', 100),
      transition('a1', 130, { status: 'exhausted', terminalReason: 'max_attempts', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
      transition('a1', 140, { status: 'recovered', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
    ]);
    expect(joined).toMatchObject({ firstTerminal: { status: 'exhausted' }, latestStatus: 'recovered', schedulerRecovered: { persistedAtMs: 140 } });
  });

  it('records re-selection within one attempt and an attempt that ended without application', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([
      transition('a1', 100),
      transition('a1', 101, { status: 'checking', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 }),
      transition('a1', 102, { status: 'waiting', pendingTargetProfileId: 'C', pendingTargetGeneration: 3 }),
      transition('a1', 103, { status: 'exhausted', terminalReason: 'switch_limit_reached', pendingTargetProfileId: 'C', pendingTargetGeneration: 3 }),
    ]);
    expect(joined!.selected.map((entry) => entry.profileId)).toEqual(['B', 'C']);
    expect(joined!.verdict).toBe('ended_unapplied');
  });

  it('does not count another session\'s observations', () => {
    const [joined] = foldRuntimeAuthAttemptAccountJoins([...appliedAttempt('a1', 100), observed(123, member('C'), { sessionId: 's2' })]);
    expect(joined!.observations).toEqual([]);
  });
});

describe('provider account resolution for the join', () => {
  const identities: Record<string, { providerAccountId: string | null; providerOrganizationId: string | null } | Error> = {
    A: { providerAccountId: 'acct-A', providerOrganizationId: 'org-shared' },
    B: { providerAccountId: 'acct-B', providerOrganizationId: 'org-shared' },
    C: { providerAccountId: 'acct-C', providerOrganizationId: 'org-C' },
    D: new Error('unreadable'),
  };
  const resolve = (members: string[], providerOrganizationId: string) => resolveConnectedServiceGroupMemberProviderAccountResolution({
    providerOrganizationId,
    members: members.map((profileId) => ({ profileId })),
    resolveProviderAccountIdentity: async (profileId) => {
      const identity = identities[profileId];
      if (identity instanceof Error) throw identity;
      return identity ?? null;
    },
  });

  it('identifies a member only for a unique organization', async () => {
    expect(await resolve(['A', 'B', 'C'], 'org-C')).toEqual({ kind: 'unique_member', profileId: 'C' });
    expect(await resolve(['A', 'B', 'C'], 'org-shared')).toEqual({ kind: 'ambiguous', matchingProfileIds: ['A', 'B'] });
    expect(await resolve(['A', 'C'], 'org-none')).toEqual({ kind: 'unproven', reason: 'no_matching_member' });
    expect(await resolve(['C', 'D'], 'org-C')).toEqual({ kind: 'unproven', reason: 'member_identity_unreadable' });
  });
});

describe('attempt journal producers', () => {
  it('reports every committed attempt-level scheduler change through the real file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-attempt-join-'));
    const changes: Array<{ before: string | null; after: string }> = [];
    const store = observeRuntimeAuthRecoveryIntentTransitions(
      createRecoveryIntentFileStore<Intent>(join(dir, 'runtime-auth-recovery.json')),
      ({ before, after }) => changes.push({ before: before?.status ?? null, after: after.status }),
    );
    await store.write('k', intent({ attemptId: 'a1' }));
    await store.write('k', intent({ attemptId: 'a1', attemptCount: 1 })); // no attempt-level change
    await store.merge!('k', intent({ attemptId: 'a1', status: 'resumed_awaiting_proof', pendingTargetProfileId: 'B' }), (_previous, next) => next);
    await store.transact('k', (current) => ({ intent: { ...current.intent!, status: 'recovered' }, effectClaimToken: current.effectClaimToken, result: undefined }));
    expect(changes).toEqual([
      { before: null, after: 'waiting' },
      { before: 'waiting', after: 'resumed_awaiting_proof' },
      { before: 'resumed_awaiting_proof', after: 'recovered' },
    ]);
    expect((store.read('k') as Intent).status).toBe('recovered');
  });

  it('appends to and reads back the journal, reporting a torn line instead of dropping it silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-attempt-journal-'));
    const filePath = join(dir, 'journal.jsonl');
    const journal = createRuntimeAuthAttemptAccountJoinJournal({ filePath });
    expect(await journal.read()).toEqual({ events: [], invalidLines: [] });
    const events = [...appliedAttempt('a1', 100), observed(125, member('B'))];
    await Promise.all(events.map((event) => journal.append(event)));
    await appendFile(filePath, '{"v":1,"kind":"provider_acc');
    const read = await journal.read();
    expect(read.events).toEqual(events);
    expect(read.invalidLines).toHaveLength(1);
    expect(foldRuntimeAuthAttemptAccountJoins(read.events)[0]!.verdict).toBe('confirmed');
  });
});
