import type {
  ConnectedServiceAssignmentReservationV1,
  ConnectedServiceGroupMemberAssignmentReasonV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type {
  ConnectedServiceAssignmentReservationApi,
  ConnectedServiceAssignmentReservationSnapshot,
} from '@/api/connectedServices/connectedServiceAssignmentReservationApi';
import {
  resolveConnectedServiceAuthGroupSoftmaxParameters,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupCandidateSelection,
  type ConnectedServiceAuthGroupMember,
  type ConnectedServiceAuthGroupMemberRuntimeState,
  type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';

/**
 * One per-session member decision for a per_session_softmax group (spec A.2, A.3, A.5 C1–C2).
 *
 * Ordering: read shared reservations → choose → durably persist the proposal (caller callback)
 * → PUT the reservation → resolve custody. No provider effect may happen while custody is
 * `proposed`; the caller performs effects only after this returns.
 */
export type PerSessionAssignmentCustody = 'reserved' | 'local_degraded' | 'reservation_uncertain';

export type PerSessionAssignmentProposal = Readonly<{
  decisionId: string;
  proposalRevision: number;
  profileId: string;
  reason: ConnectedServiceGroupMemberAssignmentReasonV1;
  fromProfileId: string | null;
  temperature: number;
  offsetPercent: number;
  probability: number | null;
  decidedAtMs: number;
  custody: 'proposed' | PerSessionAssignmentCustody;
  observedReservationRevision: number | null;
}>;

export type PerSessionAssignmentDecision =
  | Readonly<{ kind: 'assigned'; proposal: PerSessionAssignmentProposal & { custody: PerSessionAssignmentCustody } }>
  | Readonly<{ kind: 'no_candidate'; selection: ConnectedServiceAuthGroupCandidateSelection }>
  | Readonly<{ kind: 'initial_profile_invalid'; profileId: string }>;

export type DecidePerSessionGroupMemberInput = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  sessionId: string;
  ownerMachineId: string;
  decisionId: string;
  policy: ConnectedServiceAuthGroupPolicyV1;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  quotaFreshnessMs: number;
  nowMs: () => number;
  /** This session's failed/current member, excluded from a replacement draw. */
  currentProfileId: string | null;
  /** Explicit named start (spec A.4). */
  initialProfileId?: string | null;
  /** Failure classification for failover decisions; absent for an initial spawn. */
  switchReason?: string;
  requiredModelIds?: ReadonlyArray<string>;
  /** Members the caller already found ineligible for this decision (e.g. a pending target). */
  additionallyExcludedProfileIds?: ReadonlySet<string>;
  reservationApi: ConnectedServiceAssignmentReservationApi | null;
  /** Counts of this daemon's own live decisions, used only in degraded mode. */
  localReservationCountsByProfileId: () => ReadonlyMap<string, number>;
  uniformSample: () => number;
  /** Durable C1/C2 write; must complete before this function proceeds. */
  persistProposal: (proposal: PerSessionAssignmentProposal) => Promise<void>;
  /** Caller's existing spawn/recovery deadline; conflicts retry until it passes. */
  deadlineAtMs: number;
  /** Optional log sink for `assignment_reservation_unavailable` and similar events. */
  log?: (event: string, detail: Record<string, unknown>) => void;
}>;

export function countLiveReservations(
  reservations: ReadonlyArray<ConnectedServiceAssignmentReservationV1>,
  nowMs: number,
  excludeDecisionId: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of reservations) {
    if (entry.decisionId === excludeDecisionId || entry.leaseUntilMs <= nowMs) continue;
    counts.set(entry.profileId, (counts.get(entry.profileId) ?? 0) + 1);
  }
  return counts;
}

function isNamedMemberEligible(input: DecidePerSessionGroupMemberInput, profileId: string): boolean {
  const member = input.members.find((candidate) => candidate.profileId === profileId);
  if (!member) return false;
  // Eligibility only: reuse every hard exclusion via a deterministic single-member evaluation.
  const selection = selectConnectedServiceAuthGroupCandidate({
    nowMs: input.nowMs(),
    quotaFreshnessMs: input.quotaFreshnessMs,
    activeProfileId: profileId,
    allowCurrentProfileRetry: true,
    policy: { ...input.policy, strategy: 'priority' },
    members: [member],
    memberStatesByProfileId: input.memberStatesByProfileId,
    ...(input.requiredModelIds ? { requiredModelIds: input.requiredModelIds } : {}),
  });
  return selection.selected?.profileId === profileId;
}

function drawMember(
  input: DecidePerSessionGroupMemberInput,
  params: Readonly<{ counts: ReadonlyMap<string, number>; degraded: boolean; excludeProfileId: string | null }>,
): ConnectedServiceAuthGroupCandidateSelection {
  const extra = input.additionallyExcludedProfileIds ?? new Set<string>();
  return selectConnectedServiceAuthGroupCandidate({
    nowMs: input.nowMs(),
    quotaFreshnessMs: input.quotaFreshnessMs,
    activeProfileId: params.excludeProfileId,
    policy: input.policy,
    members: input.members.filter((member) => !extra.has(member.profileId)),
    memberStatesByProfileId: input.memberStatesByProfileId,
    ...(input.requiredModelIds ? { requiredModelIds: input.requiredModelIds } : {}),
    ...(input.switchReason ? { switchReason: input.switchReason } : {}),
    perSession: {
      reservationCountsByProfileId: params.counts,
      uniformSample: input.uniformSample(),
      degraded: params.degraded,
    },
  });
}

function isChoice(value: Choice | ConnectedServiceAuthGroupCandidateSelection): value is Choice {
  return typeof (value as Choice).reason === 'string' && typeof (value as Choice).profileId === 'string';
}

type Choice = Readonly<{
  profileId: string;
  reason: ConnectedServiceGroupMemberAssignmentReasonV1;
  probability: number | null;
  temperature: number;
  offsetPercent: number;
}>;

export async function decidePerSessionGroupMember(input: DecidePerSessionGroupMemberInput): Promise<PerSessionAssignmentDecision> {
  const initialProfileId = input.initialProfileId ?? null;
  if (initialProfileId && !input.members.some((member) => member.profileId === initialProfileId)) {
    return { kind: 'initial_profile_invalid', profileId: initialProfileId };
  }
  const namedStartEligible = initialProfileId !== null && isNamedMemberEligible(input, initialProfileId);
  const sampledReason: ConnectedServiceGroupMemberAssignmentReasonV1 = input.switchReason
    ? 'failover'
    : initialProfileId ? 'initial_unavailable_failover' : 'initial_sampled';

  let snapshot: ConnectedServiceAssignmentReservationSnapshot | null = null;
  let degraded = input.reservationApi === null;
  if (input.reservationApi) {
    const listed = await input.reservationApi.listAssignmentReservations({ serviceId: input.serviceId, groupId: input.groupId });
    if (listed.kind === 'ok') {
      snapshot = listed;
    } else {
      // A failed read commits nothing, so local degraded selection is still safe here.
      degraded = true;
      input.log?.('assignment_reservation_unavailable', { stage: 'list', detail: listed.detail });
    }
  }

  const choose = (counts: ReadonlyMap<string, number>, useDegraded: boolean): Choice | ConnectedServiceAuthGroupCandidateSelection => {
    if (namedStartEligible) {
      // An eligible explicit start is not a weighted draw.
      return {
        profileId: initialProfileId!,
        reason: 'initial_requested',
        probability: null,
        ...resolveConnectedServiceAuthGroupSoftmaxParameters(input.policy, useDegraded),
      };
    }
    const selection = drawMember(input, {
      counts,
      degraded: useDegraded,
      excludeProfileId: initialProfileId ?? input.currentProfileId,
    });
    if (!selection.selected || !selection.perSessionDecision) return selection;
    return {
      profileId: selection.selected.profileId,
      reason: sampledReason,
      probability: selection.perSessionDecision.selectedProbability,
      temperature: selection.perSessionDecision.temperature,
      offsetPercent: selection.perSessionDecision.offsetPercent,
    };
  };

  const countsFor = (current: ConnectedServiceAssignmentReservationSnapshot | null) => (current && !degraded
    ? countLiveReservations(current.reservations, input.nowMs(), input.decisionId)
    : new Map(input.localReservationCountsByProfileId()));

  const first = choose(countsFor(snapshot), degraded);
  if (!isChoice(first)) return { kind: 'no_candidate', selection: first };
  let choice: Choice = first;

  let proposalRevision = 1;
  const decidedAtMs = input.nowMs();
  const proposalFor = (current: Choice, custody: PerSessionAssignmentProposal['custody']): PerSessionAssignmentProposal => ({
    decisionId: input.decisionId,
    proposalRevision,
    profileId: current.profileId,
    reason: current.reason,
    fromProfileId: input.currentProfileId,
    temperature: current.temperature,
    offsetPercent: current.offsetPercent,
    probability: current.probability,
    decidedAtMs,
    custody,
    observedReservationRevision: snapshot?.reservationRevision ?? null,
  });

  if (degraded || !input.reservationApi || !snapshot) {
    const proposal = proposalFor(choice, 'local_degraded');
    await input.persistProposal(proposal);
    return { kind: 'assigned', proposal: { ...proposal, custody: 'local_degraded' } };
  }

  // C1: durable proposal before any reservation mutation or effect.
  await input.persistProposal(proposalFor(choice, 'proposed'));

  for (;;) {
    const current = choice;
    const put = await input.reservationApi.putAssignmentReservation({
      serviceId: input.serviceId,
      groupId: input.groupId,
      decisionId: input.decisionId,
      body: {
        profileId: current.profileId,
        sessionId: input.sessionId,
        ownerMachineId: input.ownerMachineId,
        state: 'pending',
        leaseUntilMs: input.nowMs() + input.policy.probeIfSnapshotOlderThanMs,
        expectedReservationRevision: snapshot.reservationRevision,
      },
    });

    if (put.kind === 'reserved') {
      const proposal = { ...proposalFor(current, 'reserved'), observedReservationRevision: put.reservationRevision };
      await input.persistProposal(proposal);
      return { kind: 'assigned', proposal: { ...proposal, custody: 'reserved' } };
    }

    if (put.kind === 'unavailable') {
      // Definitely nothing committed: local degraded selection with τ_degraded = 2τ.
      input.log?.('assignment_reservation_unavailable', { stage: 'put', detail: put.detail });
      degraded = true;
      const degradedChoice = choose(new Map(input.localReservationCountsByProfileId()), true);
      if (!isChoice(degradedChoice)) return { kind: 'no_candidate', selection: degradedChoice };
      proposalRevision += 1;
      const proposal = proposalFor(degradedChoice, 'local_degraded');
      await input.persistProposal(proposal);
      return { kind: 'assigned', proposal: { ...proposal, custody: 'local_degraded' } };
    }

    if (put.kind === 'uncertain') {
      // R3/R4: keep the original ID and target; reconcile by exact read, never redraw.
      const reconciled = await input.reservationApi.listAssignmentReservations({ serviceId: input.serviceId, groupId: input.groupId });
      if (reconciled.kind === 'ok') {
        const entry = reconciled.reservations.find((candidate) => candidate.decisionId === input.decisionId);
        if (entry && entry.profileId === current.profileId) {
          const proposal = { ...proposalFor(current, 'reserved'), observedReservationRevision: reconciled.reservationRevision };
          await input.persistProposal(proposal);
          return { kind: 'assigned', proposal: { ...proposal, custody: 'reserved' } };
        }
        if (!entry && input.nowMs() < input.deadlineAtMs) {
          // Reconciled absence: the identical PUT may be re-sent against the observed revision.
          snapshot = reconciled;
          continue;
        }
      }
      const proposal = proposalFor(current, 'reservation_uncertain');
      await input.persistProposal(proposal);
      return { kind: 'assigned', proposal: { ...proposal, custody: 'reservation_uncertain' } };
    }

    if (put.kind === 'decision_mismatch') {
      const stored = put.reservations.find((candidate) => candidate.decisionId === input.decisionId);
      if (stored && stored.sessionId === input.sessionId) {
        // Our own earlier proposal committed: replay reuses its exact target (R1).
        const adopted: Choice = { ...current, profileId: stored.profileId };
        snapshot = put;
        const proposal = { ...proposalFor(adopted, 'reserved'), observedReservationRevision: put.reservationRevision };
        await input.persistProposal(proposal);
        return { kind: 'assigned', proposal: { ...proposal, custody: 'reserved' } };
      }
      throw new Error(`assignment_reservation_decision_mismatch for decision ${input.decisionId}`);
    }

    // put.kind === 'conflict': definite, nothing stored (R2).
    snapshot = put;
    if (input.nowMs() >= input.deadlineAtMs) {
      throw new Error(`assignment reservation conflicts did not settle before the caller deadline (${input.decisionId})`);
    }
    proposalRevision += 1;
    if (current.reason === 'initial_requested') {
      // A named start keeps its requested target through unrelated revision conflicts.
      choice = current;
    } else {
      const next = choose(countsFor(snapshot), false);
      if (!isChoice(next)) return { kind: 'no_candidate', selection: next };
      choice = next;
    }
    await input.persistProposal(proposalFor(choice, 'proposed'));
  }
}
