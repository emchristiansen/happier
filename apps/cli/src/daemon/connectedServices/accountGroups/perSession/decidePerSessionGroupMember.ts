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
 * One per-session member decision for a per_session_softmax group (spec A.2, A.3, A.5 C1–C2, R1–R5).
 *
 * Ordering: read shared reservations → choose → durably persist the proposal (caller callback)
 * → PUT the reservation → resolve custody. No provider effect may happen while custody is
 * `proposed`; the caller performs effects only after an `assigned` result.
 *
 * A durable `proposed` proposal is written ahead of its PUT, so it always means "this exact PUT may
 * have been sent and may still commit". Replay therefore re-sends that identical PUT and never
 * degrades or redraws until a definite conflict proves the original revision can no longer commit.
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
  /** For `proposed`: the `expectedReservationRevision` of this proposal's PUT. Afterwards: the revision that settled it. */
  observedReservationRevision: number | null;
  /**
   * `leaseUntilMs` of this proposal's PUT, persisted with the proposal so a replay re-sends the
   * byte-identical request. Absent only on entries written before this field existed.
   */
  reservationLeaseUntilMs?: number;
}>;

export type PerSessionProposedAssignment = PerSessionAssignmentProposal & Readonly<{ custody: 'proposed' }>;

export type PerSessionAssignmentDecision =
  | Readonly<{ kind: 'assigned'; proposal: PerSessionAssignmentProposal & { custody: PerSessionAssignmentCustody } }>
  /**
   * R4 before the caller's deadline: a potentially committing PUT has an unsettled outcome and
   * reconciliation failed. No effect is permitted. The durable proposal stays `proposed`; the caller
   * retries later by passing it back as `resumeProposal` with the SAME `deadlineAtMs`. Once that
   * deadline passes, the retry returns `assigned` with `reservation_uncertain` on the same ID/target.
   */
  | Readonly<{ kind: 'custody_unresolved'; pendingProposal: PerSessionProposedAssignment; detail: string; deadlineAtMs: number }>
  | Readonly<{ kind: 'no_candidate'; selection: ConnectedServiceAuthGroupCandidateSelection }>
  | Readonly<{ kind: 'initial_profile_invalid'; profileId: string; code: 'initial_profile_not_member' | 'initial_profile_disabled'; exclusionReason?: string }>;

/**
 * The server holds this decision ID for a different (profile, session, owner machine) tuple than the
 * durable proposal. Never adopted or overwritten; no effect may follow (spec A.3, A.5).
 */
export class PerSessionReservationDecisionMismatchError extends Error {
  readonly code = 'assignment_reservation_decision_mismatch';

  constructor(
    readonly proposal: PerSessionAssignmentProposal,
    readonly stored: ConnectedServiceAssignmentReservationV1 | null,
  ) {
    super(`assignment_reservation_decision_mismatch for decision ${proposal.decisionId}`);
    this.name = 'PerSessionReservationDecisionMismatchError';
  }
}

/** Identical PUTs (original plus resends after reconciled absence) one call makes before deferring to the caller's retry. */
const MAX_IDENTICAL_SENDS_PER_CALL = 2;

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
  /** Recorded reason for a replacement draw when it is more specific than `failover` (e.g. `member_revoked`). */
  replacementReason?: ConnectedServiceGroupMemberAssignmentReasonV1;
  requiredModelIds?: ReadonlyArray<string>;
  /** Members the caller already found ineligible for this decision (e.g. a pending target). */
  additionallyExcludedProfileIds?: ReadonlySet<string>;
  reservationApi: ConnectedServiceAssignmentReservationApi | null;
  /** Counts of this daemon's own live decisions, used only in degraded mode. */
  localReservationCountsByProfileId: () => ReadonlyMap<string, number>;
  uniformSample: () => number;
  /** Durable C1/C2 write; must complete before this function proceeds. */
  persistProposal: (proposal: PerSessionAssignmentProposal) => Promise<void>;
  /**
   * A durable C1 proposal (custody `proposed`) found on replay: resume that exact proposal at C2
   * with the identical decision ID and target instead of drawing again.
   */
  resumeProposal?: PerSessionAssignmentProposal | null;
  /** Caller's existing spawn/recovery deadline; conflicts retry until it passes. */
  deadlineAtMs: number;
  /**
   * Re-reads the group's members and runtime states. A definite conflict means the decision was not
   * admitted, so its re-proposal re-evaluates eligibility on current state (spec A.5 R2), including a
   * named start's (which fails over when its member became unavailable meanwhile).
   */
  reloadMemberState?: () => Promise<Readonly<{
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  }> | null>;
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

/** Named-member classification: eligible, runtime-unavailable (fail over), or configuration-invalid (reject). */
function classifyNamedMember(
  input: DecidePerSessionGroupMemberInput,
  profileId: string,
): Readonly<{ kind: 'eligible' } | { kind: 'runtime_unavailable' } | { kind: 'configuration_invalid'; exclusionReason: string }> {
  const member = input.members.find((candidate) => candidate.profileId === profileId);
  if (!member) return { kind: 'configuration_invalid', exclusionReason: 'not_member' };
  if (!member.enabled) return { kind: 'configuration_invalid', exclusionReason: 'disabled' };
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
  if (selection.selected?.profileId === profileId) return { kind: 'eligible' };
  const exclusion = selection.excluded.find((entry) => entry.profileId === profileId);
  // Disabled or not entitled is configuration-invalid; every other exclusion is runtime availability.
  return exclusion?.reason === 'disabled'
    ? { kind: 'configuration_invalid', exclusionReason: 'disabled' }
    : { kind: 'runtime_unavailable' };
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
  const named = initialProfileId ? classifyNamedMember(input, initialProfileId) : null;
  if (initialProfileId && named?.kind === 'configuration_invalid') {
    return {
      kind: 'initial_profile_invalid',
      profileId: initialProfileId,
      code: named.exclusionReason === 'not_member' ? 'initial_profile_not_member' : 'initial_profile_disabled',
      exclusionReason: named.exclusionReason,
    };
  }
  // Current group state; replaced on a definite conflict by the caller's reload (when supplied).
  let current: DecidePerSessionGroupMemberInput = input;
  let namedStartEligible = named?.kind === 'eligible';
  const sampledReason: ConnectedServiceGroupMemberAssignmentReasonV1 = input.switchReason
    ? input.replacementReason ?? 'failover'
    : initialProfileId ? 'initial_unavailable_failover' : 'initial_sampled';

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
    const selection = drawMember(current, {
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
  const localCounts = () => new Map(input.localReservationCountsByProfileId());

  const resume: PerSessionProposedAssignment | null = input.resumeProposal?.custody === 'proposed'
    && input.resumeProposal.decisionId === input.decisionId
    ? { ...input.resumeProposal, custody: 'proposed' }
    : null;
  const decidedAtMs = resume?.decidedAtMs ?? input.nowMs();
  const fromProfileId = resume ? resume.fromProfileId : input.currentProfileId;
  const proposalFrom = (choice: Choice, proposalRevision: number, custody: PerSessionAssignmentProposal['custody'], observedReservationRevision: number | null) => ({
    decisionId: input.decisionId,
    proposalRevision,
    profileId: choice.profileId,
    reason: choice.reason,
    fromProfileId,
    temperature: choice.temperature,
    offsetPercent: choice.offsetPercent,
    probability: choice.probability,
    decidedAtMs,
    custody,
    observedReservationRevision,
  });
  // C1/R2: a proposal fixes its exact PUT (expected revision and lease) before anything is sent.
  const proposedFrom = (choice: Choice, proposalRevision: number, expectedReservationRevision: number): PerSessionProposedAssignment => ({
    ...proposalFrom(choice, proposalRevision, 'proposed', expectedReservationRevision),
    custody: 'proposed',
    reservationLeaseUntilMs: input.nowMs() + input.policy.probeIfSnapshotOlderThanMs,
  });
  const degradedFrom = async (proposalRevision: number): Promise<PerSessionAssignmentDecision> => {
    const degradedChoice = choose(localCounts(), true);
    if (!isChoice(degradedChoice)) return { kind: 'no_candidate', selection: degradedChoice };
    const proposal = { ...proposalFrom(degradedChoice, proposalRevision, 'local_degraded', null), custody: 'local_degraded' as const };
    await input.persistProposal(proposal);
    return { kind: 'assigned', proposal };
  };

  let proposal: PerSessionProposedAssignment;
  // Whether a PUT that may still commit has been sent for the current proposal. A durable proposal is
  // written ahead of its PUT, so a resumed one may already have been sent (R3–R5).
  let sendOutstanding: boolean;
  if (resume) {
    proposal = resume;
    sendOutstanding = true;
  } else {
    let snapshot: ConnectedServiceAssignmentReservationSnapshot | null = null;
    if (input.reservationApi) {
      const listed = await input.reservationApi.listAssignmentReservations({ serviceId: input.serviceId, groupId: input.groupId });
      if (listed.kind === 'ok') {
        snapshot = listed;
      } else {
        input.log?.('assignment_reservation_unavailable', { stage: 'list', detail: listed.detail });
      }
    }
    // R5: nothing has been sent for this decision, so a failed read permits local degraded selection.
    if (!snapshot) return await degradedFrom(1);
    const first = choose(countLiveReservations(snapshot.reservations, input.nowMs(), input.decisionId), false);
    if (!isChoice(first)) return { kind: 'no_candidate', selection: first };
    proposal = proposedFrom(first, 1, snapshot.reservationRevision);
    await input.persistProposal(proposal);
    sendOutstanding = false;
  }

  const unresolved = async (current: PerSessionProposedAssignment, detail: string): Promise<PerSessionAssignmentDecision> => {
    if (input.nowMs() < input.deadlineAtMs) {
      input.log?.('assignment_reservation_custody_unresolved', { decisionId: input.decisionId, detail });
      return { kind: 'custody_unresolved', pendingProposal: current, detail, deadlineAtMs: input.deadlineAtMs };
    }
    // R4: the caller's deadline requires action; only the same ID/target can have been reserved.
    const uncertain = { ...current, custody: 'reservation_uncertain' as const };
    await input.persistProposal(uncertain);
    return { kind: 'assigned', proposal: uncertain };
  };
  const matchesProposal = (entry: ConnectedServiceAssignmentReservationV1, current: PerSessionAssignmentProposal) =>
    entry.decisionId === current.decisionId && entry.profileId === current.profileId
    && entry.sessionId === input.sessionId && entry.ownerMachineId === input.ownerMachineId;
  const reserved = async (current: PerSessionProposedAssignment, reservationRevision: number): Promise<PerSessionAssignmentDecision> => {
    const settled = { ...current, custody: 'reserved' as const, observedReservationRevision: reservationRevision };
    await input.persistProposal(settled);
    return { kind: 'assigned', proposal: settled };
  };

  const api = input.reservationApi;
  if (!api) return await unresolved(proposal, 'reservation_api_absent');
  let identicalSends = 0;
  for (;;) {
    const expectedReservationRevision = proposal.observedReservationRevision;
    if (expectedReservationRevision === null) {
      throw new Error(`durable proposal ${proposal.decisionId} is proposed without an observed reservation revision`);
    }
    const put = await api.putAssignmentReservation({
      serviceId: input.serviceId,
      groupId: input.groupId,
      decisionId: input.decisionId,
      body: {
        profileId: proposal.profileId,
        sessionId: input.sessionId,
        ownerMachineId: input.ownerMachineId,
        state: 'pending',
        // Entries written before the lease was persisted derive it from their own durable fields.
        leaseUntilMs: proposal.reservationLeaseUntilMs ?? proposal.decidedAtMs + input.policy.probeIfSnapshotOlderThanMs,
        expectedReservationRevision,
      },
    });
    identicalSends += 1;

    if (put.kind === 'reserved') {
      // R1: acknowledged.
      if (!matchesProposal(put.reservation, proposal)) throw new PerSessionReservationDecisionMismatchError(proposal, put.reservation);
      return await reserved(proposal, put.reservationRevision);
    }

    if (put.kind === 'decision_mismatch') {
      throw new PerSessionReservationDecisionMismatchError(
        proposal,
        put.reservations.find((candidate) => candidate.decisionId === input.decisionId) ?? null,
      );
    }

    if (put.kind === 'conflict') {
      // R2: definite, nothing stored. Every PUT sent for this decision carried a revision at or below
      // the refused one, so none of them can commit any more.
      sendOutstanding = false;
      if (input.nowMs() >= input.deadlineAtMs) {
        throw new Error(`assignment reservation conflicts did not settle before the caller deadline (${input.decisionId})`);
      }
      const reloaded = input.reloadMemberState ? await input.reloadMemberState() : null;
      if (reloaded) {
        current = { ...input, members: reloaded.members, memberStatesByProfileId: reloaded.memberStatesByProfileId };
        if (proposal.reason === 'initial_requested' && initialProfileId) {
          const recheck = classifyNamedMember(current, initialProfileId);
          if (recheck.kind === 'configuration_invalid') {
            return {
              kind: 'initial_profile_invalid',
              profileId: initialProfileId,
              code: recheck.exclusionReason === 'not_member' ? 'initial_profile_not_member' : 'initial_profile_disabled',
              exclusionReason: recheck.exclusionReason,
            };
          }
          // Runtime-unavailable now: the named start fails over to a weighted draw without it.
          namedStartEligible = recheck.kind === 'eligible';
        }
      }
      const next: Choice | ConnectedServiceAuthGroupCandidateSelection = proposal.reason === 'initial_requested' && namedStartEligible
        // A named start that is still eligible keeps its requested target through revision conflicts.
        ? proposal
        : choose(countLiveReservations(put.reservations, input.nowMs(), input.decisionId), false);
      if (!isChoice(next)) return { kind: 'no_candidate', selection: next };
      proposal = proposedFrom(next, proposal.proposalRevision + 1, put.reservationRevision);
      await input.persistProposal(proposal);
      identicalSends = 0;
      continue;
    }

    if (put.kind === 'unavailable') {
      input.log?.('assignment_reservation_unavailable', { stage: 'put', detail: put.detail });
      // R5 only when nothing potentially committing was sent; otherwise the original may still commit.
      if (!sendOutstanding) return await degradedFrom(proposal.proposalRevision + 1);
      return await unresolved(proposal, `put_unavailable_after_uncertain_send:${put.detail}`);
    }

    // put.kind === 'uncertain' (R3): keep the ID/target; reconcile by exact read, never redraw.
    sendOutstanding = true;
    const reconciled = await api.listAssignmentReservations({ serviceId: input.serviceId, groupId: input.groupId });
    if (reconciled.kind !== 'ok') return await unresolved(proposal, `reconcile_${reconciled.kind}:${reconciled.detail}`);
    const entry = reconciled.reservations.find((candidate) => candidate.decisionId === input.decisionId);
    if (entry) {
      if (!matchesProposal(entry, proposal)) throw new PerSessionReservationDecisionMismatchError(proposal, entry);
      return await reserved(proposal, reconciled.reservationRevision);
    }
    // Absent: re-send the identical PUT (a no-op if the original lands first; a conflict if it can no longer commit).
    if (identicalSends < MAX_IDENTICAL_SENDS_PER_CALL) continue;
    return await unresolved(proposal, `put_uncertain:${put.detail}`);
  }
}
