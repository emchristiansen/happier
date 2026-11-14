import {
  CONNECTED_SERVICE_AUTH_GROUP_PER_SESSION_SOFTMAX_SERVICE_IDS,
  type ConnectedServiceGroupMaterializedAssignmentV1,
  type ConnectedServiceGroupMemberAssignmentV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';
import type { ConnectedServiceBindingSelection } from '../../parseConnectedServicesBindings';
import { resolvePerSessionTargetProfileId } from '../../parseConnectedServicesBindings';
import type { ConnectedServiceAuthGroupSwitchState } from '../switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { selectConnectedServiceAuthGroupCandidate } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { createCryptoUniformSample } from '../selection/perSessionOffsetOddsSelection';
import type { PerSessionAssignmentProposal } from './decidePerSessionGroupMember';
import { decidePerSessionGroupMemberUntilSettled } from './decidePerSessionGroupMemberUntilSettled';
import type { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';

/** Daemon facilities a per_session_softmax spawn needs; absent means this host cannot serve one. */
export type PerSessionSpawnAssignmentDeps = Readonly<{
  ledger: PerSessionAssignmentLedger;
  ownerMachineId: string;
  reservationApi: ConnectedServiceAssignmentReservationApi | null;
  /** Releases a decision this spawn created when the attempt fails before any runner exists. */
  releaseAfterDefinitePreLaunchFailure: (decisionId: string) => Promise<boolean>;
  uniformSample?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}>;

export class ConnectedServicePerSessionSpawnError extends Error {
  constructor(
    readonly code:
      | 'connect_group_strategy_unsupported_for_service'
      | 'per_session_assignment_host_unsupported'
      | 'per_session_assignment_session_required'
      | 'initial_profile_requires_per_session_group'
      | 'initial_profile_not_member'
      | 'initial_profile_disabled'
      | 'no_eligible_member',
    message: string,
    readonly retryAtMs: number | null = null,
  ) {
    super(message);
    this.name = 'ConnectedServicePerSessionSpawnError';
  }
}

export type PerSessionSpawnAssignment = Readonly<{
  profileId: string;
  decisionId: string;
  /**
   * True when this spawn attempt owns the decision (new draw, resumed proposal or replayed attempt);
   * false when it reuses the session's own persisted member/target, which the session keeps owning.
   */
  ownedByAttempt: boolean;
  /** What the canonical binding records: the reused applied member, or a new pending target. */
  binding:
    | Readonly<{ kind: 'member'; member: ConnectedServiceGroupMemberAssignmentV1 }>
    | Readonly<{ kind: 'materialized'; materializedAssignment: ConnectedServiceGroupMaterializedAssignmentV1 }>;
}>;

function toMaterialized(proposal: PerSessionAssignmentProposal, nowMs: number): ConnectedServiceGroupMaterializedAssignmentV1 {
  return {
    profileId: proposal.profileId,
    decisionId: proposal.decisionId,
    reason: proposal.reason,
    ...(proposal.fromProfileId ? { fromProfileId: proposal.fromProfileId } : {}),
    materializedAtMs: nowMs,
    ...(Number.isFinite(proposal.temperature) ? { temperature: proposal.temperature } : {}),
    ...(Number.isFinite(proposal.offsetPercent) ? { offsetPercent: proposal.offsetPercent } : {}),
    ...(proposal.probability === null ? {} : { probability: proposal.probability }),
  };
}

/** Whether one member can serve this session now: membership, enablement, health, quota and exact model. */
export function isPerSessionMemberEligible(
  state: ConnectedServiceAuthGroupSwitchState,
  profileId: string,
  nowMs: number,
  quotaFreshnessMs: number,
  requiredModelIds: ReadonlyArray<string>,
): boolean {
  const member = state.members.find((candidate) => candidate.profileId === profileId);
  if (!member) return false;
  return selectConnectedServiceAuthGroupCandidate({
    nowMs,
    quotaFreshnessMs,
    activeProfileId: profileId,
    allowCurrentProfileRetry: true,
    policy: { ...state.policy, strategy: 'priority' },
    members: [member],
    memberStatesByProfileId: state.memberStatesByProfileId,
    ...(requiredModelIds.length > 0 ? { requiredModelIds } : {}),
  }).selected?.profileId === profileId;
}

/** Whether the session's own persisted member/pending target is still usable for this launch. */
export function isPerSessionOwnedTargetUsable(input: Readonly<{
  state: ConnectedServiceAuthGroupSwitchState;
  selection: Extract<ConnectedServiceBindingSelection, { kind: 'group' }>;
  nowMs: number;
  quotaFreshnessMs: number;
  requiredModelIds: ReadonlyArray<string>;
}>): boolean {
  const target = resolvePerSessionTargetProfileId(input.selection);
  return target !== null && isPerSessionMemberEligible(input.state, target, input.nowMs, input.quotaFreshnessMs, input.requiredModelIds);
}

/**
 * Resolves the member a per_session_softmax spawn materializes on (spec A.4):
 * - resume of the same session reuses its own pending/applied member after revalidation;
 * - an eligible explicit `initialProfileId` starts there; an ineligible one fails over;
 * - otherwise one offset-odds draw with shared reservations.
 * Replayed spawns reuse their unadopted ledger decision instead of drawing again.
 */
export async function resolvePerSessionGroupMemberForSpawn(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  selection: Extract<ConnectedServiceBindingSelection, { kind: 'group' }>;
  state: ConnectedServiceAuthGroupSwitchState;
  sessionId: string | undefined;
  quotaFreshnessMs: number;
  nowMs: () => number;
  deadlineAtMs: number;
  deps: PerSessionSpawnAssignmentDeps | null;
  /** This session's exact model (spec A.2, T13); empty when it runs the provider default. */
  requiredModelIds: ReadonlyArray<string>;
  /** Fresh group state for re-evaluating eligibility after a definite reservation conflict. */
  reloadState?: () => Promise<ConnectedServiceAuthGroupSwitchState | null>;
}>): Promise<PerSessionSpawnAssignment> {
  if (!(CONNECTED_SERVICE_AUTH_GROUP_PER_SESSION_SOFTMAX_SERVICE_IDS as readonly string[]).includes(input.serviceId)) {
    throw new ConnectedServicePerSessionSpawnError('connect_group_strategy_unsupported_for_service',
      `per_session_softmax is supported only for claude-subscription groups (${input.serviceId}/${input.groupId})`);
  }
  if (!input.deps) {
    throw new ConnectedServicePerSessionSpawnError('per_session_assignment_host_unsupported',
      `this daemon cannot host per-session assignments (${input.serviceId}/${input.groupId})`);
  }
  if (!input.sessionId) {
    throw new ConnectedServicePerSessionSpawnError('per_session_assignment_session_required',
      'a per-session assignment requires the spawned session id');
  }
  const deps = input.deps;
  const sessionId = input.sessionId;
  const nowMs = input.nowMs();

  // Resume: the same session's own assignment, revalidated.
  const eligible = (profileId: string) => isPerSessionMemberEligible(input.state, profileId, nowMs, input.quotaFreshnessMs, input.requiredModelIds);
  const ownTarget = resolvePerSessionTargetProfileId(input.selection);
  if (ownTarget && eligible(ownTarget)) {
    if (input.selection.materializedAssignment) {
      return {
        profileId: ownTarget,
        decisionId: input.selection.materializedAssignment.decisionId,
        ownedByAttempt: false,
        binding: { kind: 'materialized', materializedAssignment: input.selection.materializedAssignment },
      };
    }
    return {
      profileId: ownTarget,
      decisionId: input.selection.member!.decisionId,
      ownedByAttempt: false,
      binding: { kind: 'member', member: input.selection.member! },
    };
  }

  // Replay of an unadopted spawn decision for this session and group.
  const replay = deps.ledger.list().find((entry) => entry.origin === 'spawn' && entry.sessionId === sessionId
    && entry.serviceId === input.serviceId && entry.groupId === input.groupId && entry.state === 'pending');
  const replayEligible = !ownTarget && replay && eligible(replay.proposal.profileId);
  if (replayEligible && replay.proposal.custody !== 'proposed') {
    return {
      profileId: replay.proposal.profileId,
      decisionId: replay.decisionId,
      ownedByAttempt: true,
      binding: { kind: 'materialized', materializedAssignment: toMaterialized(replay.proposal, nowMs) },
    };
  }

  // A durable C1 proposal resumes at C2 under its own ID; otherwise this is a new decision.
  const resumeProposal = replayEligible && replay.proposal.custody === 'proposed' ? replay.proposal : null;
  if (replay && !replayEligible && !ownTarget) {
    // Actual target ineligibility supersedes the unadopted decision. One that never launched a
    // runner is released now; one that did keeps custody until that runner's retirement is proved.
    await deps.releaseAfterDefinitePreLaunchFailure(replay.decisionId);
  }
  const decisionId = resumeProposal?.decisionId ?? `spawn-${sessionId}-${nowMs.toString(36)}`;
  const decision = await decidePerSessionGroupMemberUntilSettled({
    serviceId: input.serviceId,
    groupId: input.groupId,
    sessionId,
    ownerMachineId: deps.ownerMachineId,
    decisionId,
    policy: input.state.policy,
    members: input.state.members,
    memberStatesByProfileId: input.state.memberStatesByProfileId,
    quotaFreshnessMs: input.quotaFreshnessMs,
    nowMs: input.nowMs,
    currentProfileId: ownTarget,
    initialProfileId: ownTarget ? null : (input.selection.initialProfileId ?? null),
    ...(input.requiredModelIds.length > 0 ? { requiredModelIds: input.requiredModelIds } : {}),
    reservationApi: deps.reservationApi,
    resumeProposal,
    localReservationCountsByProfileId: () => deps.ledger.localCounts(input.serviceId, input.groupId, decisionId),
    uniformSample: deps.uniformSample ?? createCryptoUniformSample,
    persistProposal: async (proposal) => {
      await deps.ledger.recordProposal({
        decisionId, sessionId, serviceId: input.serviceId, groupId: input.groupId, origin: 'spawn', proposal, nowMs: input.nowMs(),
      });
    },
    deadlineAtMs: input.deadlineAtMs,
    ...(input.reloadState ? {
      reloadMemberState: async () => {
        const fresh = await input.reloadState!();
        return fresh ? { members: fresh.members, memberStatesByProfileId: fresh.memberStatesByProfileId } : null;
      },
    } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (decision.kind === 'initial_profile_invalid') {
    throw new ConnectedServicePerSessionSpawnError(decision.code,
      `initialProfileId ${decision.profileId} is not usable in ${input.serviceId}/${input.groupId} (${decision.exclusionReason ?? decision.code})`);
  }
  if (decision.kind === 'no_candidate') {
    const retryAtMs = decision.selection.excluded
      .map((entry) => entry.retryAtMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((left, right) => left - right)[0] ?? null;
    throw new ConnectedServicePerSessionSpawnError('no_eligible_member',
      `no eligible member for a per-session assignment in ${input.serviceId}/${input.groupId}`, retryAtMs);
  }
  return {
    profileId: decision.proposal.profileId,
    decisionId,
    ownedByAttempt: true,
    binding: { kind: 'materialized', materializedAssignment: toMaterialized(decision.proposal, input.nowMs()) },
  };
}
