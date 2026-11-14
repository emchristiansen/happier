import type {
  ConnectedServiceAuthGroupV1,
  ConnectedServiceGroupMaterializedAssignmentV1,
  ConnectedServiceGroupMemberAssignmentV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceAssignmentReservationApi } from '@/api/connectedServices/connectedServiceAssignmentReservationApi';

import {
  buildPolicyWaitUntilResetResult,
  isReasonEnabled,
  resolveEarliestRetryAtMs,
  resolvePolicyRecoveryWaitRetryAtMs,
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchResult,
  type ConnectedServiceAuthGroupSwitchState,
} from '../switching/pipeline/switchPipeline';
import { createCryptoUniformSample } from '../selection/perSessionOffsetOddsSelection';
import { decidePerSessionGroupMember, type PerSessionAssignmentProposal } from './decidePerSessionGroupMember';
import type { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';

/** The session's current per-session group binding and the subject its decisions are keyed by. */
export type PerSessionSessionBinding = Readonly<{
  subjectId: string;
  initialProfileId?: string;
  member?: ConnectedServiceGroupMemberAssignmentV1;
  materializedAssignment?: ConnectedServiceGroupMaterializedAssignmentV1;
  /** Account the session currently serves on, when known (applied member, else materialized target). */
  currentProfileId: string | null;
}>;

/** A per-session group binding handed to the switch FSM: target in `materializedAssignment`. */
export type PerSessionApplyBinding = Readonly<{
  source: 'connected';
  selection: 'group';
  groupId: string;
  initialProfileId?: string;
  member?: ConnectedServiceGroupMemberAssignmentV1;
  materializedAssignment: ConnectedServiceGroupMaterializedAssignmentV1;
}>;

export type PerSessionApplyResult = Readonly<{
  ok: boolean;
  action?: string;
  errorCode?: string;
  diagnostics?: unknown;
}>;

type ClassifiedFailureInput = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  reason: string;
  observedProfileId?: string | null;
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  resetsAtMs?: number | null;
  switchesThisTurn?: number;
  sessionSwitchesThisHour?: number;
}>;

const WAITABLE_REASONS: ReadonlySet<string> = new Set(['usage_limit', 'rate_limit', 'temporary_throttle']);

function applyModeOf(action: string | undefined): 'hot_apply' | 'restart_resume' | undefined {
  if (action === 'restart_requested') return 'restart_resume';
  if (action === 'hot_applied') return 'hot_apply';
  return undefined;
}

/**
 * Classified-failure recovery for one per-session-owned session (spec A.4 "Classified failure",
 * A.5). It chooses that session's own replacement member through the shared reservation resource
 * and applies it to that session only: the group's shared `activeProfileId`/`generation` never move.
 *
 * Ordering per decision: durable proposal (ledger, origin `recovery`) → reservation custody →
 * effect through the switch FSM (restart-class, member home) → provider adoption (later, through
 * provider-observed account metadata) → applied member. A replayed failure resumes the same
 * decision rather than drawing again.
 */
export class PerSessionFailoverCoordinator {
  private readonly switchTimesBySessionKey = new Map<string, number[]>();

  constructor(private readonly deps: Readonly<{
    loadGroup: (input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<ConnectedServiceAuthGroupV1 | null>;
    buildState: (group: ConnectedServiceAuthGroupV1) => ConnectedServiceAuthGroupSwitchState;
    /** Records the failed account's health for the whole group (existing runtime-state path). */
    recordFailure: (input: ClassifiedFailureInput & Readonly<{ observedProfileId: string }>) => Promise<void>;
    readSessionBinding: (input: Readonly<{ sessionId: string; serviceId: ConnectedServiceId; groupId: string }>) => PerSessionSessionBinding | null;
    applyAssignment: (input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      generation: number;
      profileId: string;
      fromProfileId: string | null;
      reason: string;
      binding: PerSessionApplyBinding;
    }>) => Promise<PerSessionApplyResult>;
    ledger: PerSessionAssignmentLedger;
    ownerMachineId: string;
    reservationApi: ConnectedServiceAssignmentReservationApi | null;
    quotaFreshnessMs: number;
    nowMs: () => number;
    deadlineMs: number;
    uniformSample?: () => number;
    log?: (event: string, detail: Record<string, unknown>) => void;
  }>) {}

  private policyResult(input: ClassifiedFailureInput, state: ConnectedServiceAuthGroupSwitchState): ConnectedServiceAuthGroupSwitchResult | null {
    const policy = state.policy;
    const waitable = WAITABLE_REASONS.has(input.reason)
      && (policy.recoveryMode === 'wait_until_reset' || policy.recoveryMode === 'switch_or_wait');
    const waitResult = () => buildPolicyWaitUntilResetResult({
      loaded: state,
      retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
    });
    if (policy.recoveryMode === 'off') return { status: 'auto_switch_disabled', generation: state.generation };
    if (!policy.autoSwitch) return waitable ? waitResult() : { status: 'auto_switch_disabled', generation: state.generation };
    if (!isReasonEnabled(policy, input.reason)) {
      return waitable ? waitResult() : { status: 'switch_reason_disabled', generation: state.generation };
    }
    if (policy.recoveryMode === 'wait_until_reset') return waitResult();
    const switchesThisTurn = Math.max(0, Math.trunc(input.switchesThisTurn ?? 0));
    const hourly = typeof input.sessionSwitchesThisHour === 'number' && Number.isFinite(input.sessionSwitchesThisHour)
      ? Math.max(0, Math.trunc(input.sessionSwitchesThisHour))
      : this.recentSwitches(this.sessionKey(input), this.deps.nowMs());
    if (switchesThisTurn >= policy.maxSwitchesPerTurn || hourly >= policy.maxSwitchesPerSessionHour) {
      return { status: 'switch_limit_reached', generation: state.generation };
    }
    return null;
  }

  private sessionKey(input: ClassifiedFailureInput): string {
    return `${input.sessionId ?? ''}\0${input.serviceId}\0${input.groupId}`;
  }

  private recentSwitches(key: string, nowMs: number): number {
    const kept = (this.switchTimesBySessionKey.get(key) ?? []).filter((at) => nowMs - at < SESSION_SWITCH_LIMIT_WINDOW_MS);
    this.switchTimesBySessionKey.set(key, kept);
    return kept.length;
  }

  /** True when this coordinator owns recovery for the session's binding in this group. */
  async owns(input: Readonly<{ sessionId?: string; serviceId: string; groupId: string }>): Promise<boolean> {
    if (!input.sessionId) return false;
    const group = await this.deps.loadGroup({ serviceId: input.serviceId as ConnectedServiceId, groupId: input.groupId });
    return group?.policy?.strategy === 'per_session_softmax';
  }

  async switchAfterClassifiedFailure(input: ClassifiedFailureInput): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const serviceId = input.serviceId as ConnectedServiceId;
    const sessionId = input.sessionId;
    const group = await this.deps.loadGroup({ serviceId, groupId: input.groupId });
    if (!group || !sessionId) {
      throw new Error(`per-session recovery requires a session and its group (${input.serviceId}/${input.groupId})`);
    }
    const binding = this.deps.readSessionBinding({ sessionId, serviceId, groupId: input.groupId });
    const failedProfileId = input.observedProfileId?.trim() || binding?.currentProfileId || null;
    if (failedProfileId) {
      await this.deps.recordFailure({ ...input, observedProfileId: failedProfileId });
    }
    const state = this.deps.buildState((await this.deps.loadGroup({ serviceId, groupId: input.groupId })) ?? group);
    const policy = this.policyResult(input, state);
    if (policy) return policy;
    if (!binding) {
      throw new Error(`per-session recovery could not read the session binding (${sessionId})`);
    }

    // A failure for an account the session neither serves on nor targets is superseded (spec A.4).
    const pendingTarget = binding.materializedAssignment ?? null;
    if (input.observedProfileId && binding.currentProfileId
      && input.observedProfileId !== binding.currentProfileId
      && input.observedProfileId !== pendingTarget?.profileId) {
      return {
        status: 'observed_generation',
        activeProfileId: binding.currentProfileId,
        generation: state.generation,
      };
    }
    if (pendingTarget && input.observedProfileId === pendingTarget.profileId) {
      // The pending target failed before adoption (spec A.5): its health is recorded above; the
      // restart path retires its runner when the replacement applies. Supersede its decision and
      // release its reservation before drawing again without it.
      this.deps.log?.('per_session_target_failed_before_adoption', { decisionId: pendingTarget.decisionId, profileId: pendingTarget.profileId });
      await this.deps.ledger.remove(pendingTarget.decisionId);
      await this.deps.reservationApi?.deleteAssignmentReservation({
        serviceId, groupId: input.groupId, decisionId: pendingTarget.decisionId,
      });
    }

    // Replay: an unsettled recovery decision for this session resumes under its own ID.
    const replay = this.deps.ledger.list().find((entry) => entry.origin === 'recovery'
      && entry.sessionId === binding.subjectId && entry.serviceId === serviceId && entry.groupId === input.groupId
      && entry.state === 'pending' && entry.proposal.profileId !== failedProfileId);
    if (replay && binding.materializedAssignment?.decisionId === replay.decisionId) {
      // The effect was already requested for this decision; adoption proof settles it.
      return {
        status: 'switched',
        activeProfileId: replay.proposal.profileId,
        generation: state.generation,
        mode: 'restart_resume',
      };
    }
    const resumeProposal = replay?.proposal.custody === 'proposed' ? replay.proposal : null;
    const nowMs = this.deps.nowMs();
    const decisionId = resumeProposal?.decisionId
      ?? (replay && replay.proposal.custody !== 'proposed' ? replay.decisionId : null)
      ?? `recovery-${binding.subjectId}-${nowMs.toString(36)}`;

    let proposal: PerSessionAssignmentProposal;
    if (replay && !resumeProposal) {
      proposal = replay.proposal;
    } else {
      const decision = await decidePerSessionGroupMember({
        serviceId,
        groupId: input.groupId,
        sessionId: binding.subjectId,
        ownerMachineId: this.deps.ownerMachineId,
        decisionId,
        policy: state.policy,
        members: state.members,
        memberStatesByProfileId: state.memberStatesByProfileId,
        quotaFreshnessMs: this.deps.quotaFreshnessMs,
        nowMs: this.deps.nowMs,
        currentProfileId: failedProfileId,
        switchReason: input.reason,
        ...(state.requiredModelIds ? { requiredModelIds: state.requiredModelIds } : {}),
        reservationApi: this.deps.reservationApi,
        resumeProposal,
        localReservationCountsByProfileId: () => this.deps.ledger.localCounts(serviceId, input.groupId, decisionId),
        uniformSample: this.deps.uniformSample ?? createCryptoUniformSample,
        persistProposal: async (next) => {
          await this.deps.ledger.recordProposal({
            decisionId, sessionId: binding.subjectId, serviceId, groupId: input.groupId,
            origin: 'recovery', proposal: next, nowMs: this.deps.nowMs(),
          });
        },
        deadlineAtMs: nowMs + this.deps.deadlineMs,
        ...(this.deps.log ? { log: this.deps.log } : {}),
      });
      if (decision.kind === 'no_candidate') {
        return {
          status: 'no_eligible_member',
          generation: state.generation,
          groupExhausted: true,
          retryAtMs: resolveEarliestRetryAtMs(decision.selection.excluded),
          excluded: decision.selection.excluded,
        };
      }
      if (decision.kind === 'initial_profile_invalid') {
        throw new Error(`per-session recovery produced an initial-profile decision (${decision.code})`);
      }
      proposal = decision.proposal;
    }

    const materializedAssignment: ConnectedServiceGroupMaterializedAssignmentV1 = {
      profileId: proposal.profileId,
      decisionId,
      reason: proposal.reason,
      ...(failedProfileId ? { fromProfileId: failedProfileId } : {}),
      materializedAtMs: this.deps.nowMs(),
      ...(Number.isFinite(proposal.temperature) ? { temperature: proposal.temperature } : {}),
      ...(Number.isFinite(proposal.offsetPercent) ? { offsetPercent: proposal.offsetPercent } : {}),
      ...(proposal.probability === null ? {} : { probability: proposal.probability }),
    };
    const applied = await this.deps.applyAssignment({
      sessionId,
      serviceId,
      groupId: input.groupId,
      generation: state.generation,
      profileId: proposal.profileId,
      fromProfileId: failedProfileId,
      reason: input.reason,
      binding: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
        ...(binding.initialProfileId ? { initialProfileId: binding.initialProfileId } : {}),
        // The previously applied member stays the proven identity until the target is adopted.
        ...(binding.member ? { member: binding.member } : {}),
        materializedAssignment,
      },
    });
    if (!applied.ok) {
      // The decision stays durable; the scheduler's retry resumes it under the same ID.
      return {
        status: 'generation_apply_failed',
        activeProfileId: proposal.profileId,
        generation: state.generation,
        errorCode: applied.errorCode ?? 'unknown',
        ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
      };
    }
    const key = this.sessionKey(input);
    this.recentSwitches(key, this.deps.nowMs());
    this.switchTimesBySessionKey.get(key)?.push(this.deps.nowMs());
    const mode = applyModeOf(applied.action);
    return {
      status: 'switched',
      activeProfileId: proposal.profileId,
      generation: state.generation,
      ...(mode ? { mode } : {}),
      ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
    };
  }
}
