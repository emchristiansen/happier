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
import type { PerSessionAssignmentProposal } from './decidePerSessionGroupMember';
import { decidePerSessionGroupMemberUntilSettled } from './decidePerSessionGroupMemberUntilSettled';
import { isPerSessionMemberEligible } from './resolvePerSessionGroupMemberForSpawn';
import type { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';

/** The session's current per-session group binding and the subject its decisions are keyed by. */
export type PerSessionSessionBinding = Readonly<{
  subjectId: string;
  initialProfileId?: string;
  member?: ConnectedServiceGroupMemberAssignmentV1;
  materializedAssignment?: ConnectedServiceGroupMaterializedAssignmentV1;
  /** Proved serving account: the applied member; null for a pending-only target; shared launch selection otherwise. */
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
    /** Group state with `requiredModelIds` restricted to this session's own model (spec A.2, T13). */
    buildState: (group: ConnectedServiceAuthGroupV1, sessionId: string) => ConnectedServiceAuthGroupSwitchState;
    /**
     * The shared pipeline for a group that is no longer per_session_softmax. Used only to choose the
     * conversion target when the group's current shared member is the one that failed.
     */
    switchSharedGroup: (input: ClassifiedFailureInput) => Promise<ConnectedServiceAuthGroupSwitchResult>;
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

  private policyResult(
    input: ClassifiedFailureInput,
    state: ConnectedServiceAuthGroupSwitchState,
    memberRevoked: boolean,
  ): ConnectedServiceAuthGroupSwitchResult | null {
    const policy = state.policy;
    const waitable = WAITABLE_REASONS.has(input.reason)
      && (policy.recoveryMode === 'wait_until_reset' || policy.recoveryMode === 'switch_or_wait');
    const waitResult = () => buildPolicyWaitUntilResetResult({
      loaded: state,
      retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
    });
    if (policy.recoveryMode === 'off') return { status: 'auto_switch_disabled', generation: state.generation };
    if (!policy.autoSwitch) return waitable ? waitResult() : { status: 'auto_switch_disabled', generation: state.generation };
    // A revoked member cannot serve whatever the failure kind; per-reason switch toggles do not apply (spec A.4).
    if (!memberRevoked && !isReasonEnabled(policy, input.reason)) {
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

  /**
   * True when this coordinator owns recovery for the session's binding in this group: the group is
   * per_session_softmax, or the session still carries its own applied/pending per-session assignment
   * after a policy rollback (spec A.4 Migration, T12) and must be converted through the proved path.
   */
  async owns(input: Readonly<{ sessionId?: string; serviceId: string; groupId: string }>): Promise<boolean> {
    if (!input.sessionId) return false;
    const serviceId = input.serviceId as ConnectedServiceId;
    const binding = this.deps.readSessionBinding({ sessionId: input.sessionId, serviceId, groupId: input.groupId });
    if (binding?.member || binding?.materializedAssignment) return true;
    const group = await this.deps.loadGroup({ serviceId, groupId: input.groupId });
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
    const pendingTarget = binding?.materializedAssignment ?? null;
    // The account the report is about: its own observation, else the proved serving member.
    const failedProfileId = input.observedProfileId?.trim() || binding?.currentProfileId || null;
    if (failedProfileId) {
      await this.deps.recordFailure({ ...input, observedProfileId: failedProfileId });
    }
    const state = this.deps.buildState((await this.deps.loadGroup({ serviceId, groupId: input.groupId })) ?? group, sessionId);
    const memberRevoked = failedProfileId !== null
      && !state.members.some((member) => member.profileId === failedProfileId && member.enabled);
    const policy = this.policyResult(input, state, memberRevoked);
    if (policy) return policy;
    if (!binding) {
      throw new Error(`per-session recovery could not read the session binding (${sessionId})`);
    }

    // A failure for an account the session neither serves on nor targets is superseded (spec A.4).
    if (input.observedProfileId
      && input.observedProfileId !== binding.currentProfileId
      && input.observedProfileId !== pendingTarget?.profileId) {
      return {
        status: 'observed_generation',
        activeProfileId: binding.currentProfileId ?? pendingTarget?.profileId ?? null,
        generation: state.generation,
      };
    }

    if (state.policy.strategy !== 'per_session_softmax') {
      return await this.convertToSharedGroup({ input, sessionId, serviceId, binding, state, failedProfileId });
    }

    // The pending target failed before adoption (spec A.5, T20). Its health is recorded above; its
    // decision keeps custody (ledger entry and reservation) until the replacement drawn below is
    // adopted, because only that restart retires the target's runner. It is excluded from the draw.
    const targetFailed = pendingTarget !== null && failedProfileId === pendingTarget.profileId;

    // Replay: an unsettled, not-superseded recovery decision for this session resumes under its own ID.
    const replay = this.deps.ledger.list().find((entry) => entry.origin === 'recovery'
      && entry.sessionId === binding.subjectId && entry.serviceId === serviceId && entry.groupId === input.groupId
      && entry.state === 'pending' && !entry.supersededByDecisionId && entry.proposal.profileId !== failedProfileId);
    if (replay && pendingTarget?.decisionId === replay.decisionId) {
      // The effect was already requested for this decision; adoption proof settles it.
      return {
        status: 'switched',
        activeProfileId: replay.proposal.profileId,
        generation: state.generation,
        mode: 'restart_resume',
      };
    }
    const nowMs = this.deps.nowMs();
    const eligible = (profileId: string) => isPerSessionMemberEligible(
      state, profileId, nowMs, this.deps.quotaFreshnessMs, state.requiredModelIds ?? [],
    );
    // C3 recheck: a reserved decision whose target is no longer eligible is superseded, not applied.
    const replayUsable = replay && (replay.proposal.custody === 'proposed' || eligible(replay.proposal.profileId)) ? replay : null;
    const ineligibleReplay = replay && !replayUsable ? replay : null;
    if (ineligibleReplay) {
      this.deps.log?.('per_session_replay_target_ineligible', { decisionId: ineligibleReplay.decisionId, profileId: ineligibleReplay.proposal.profileId });
    }

    const resumeProposal = replayUsable?.proposal.custody === 'proposed' ? replayUsable.proposal : null;
    const decisionId = replayUsable?.decisionId ?? `recovery-${binding.subjectId}-${nowMs.toString(36)}`;
    let proposal: PerSessionAssignmentProposal;
    if (replayUsable && !resumeProposal) {
      proposal = replayUsable.proposal;
    } else {
      const excluded = new Set<string>([
        ...(targetFailed ? [pendingTarget.profileId] : []),
        ...(ineligibleReplay ? [ineligibleReplay.proposal.profileId] : []),
      ]);
      const decision = await decidePerSessionGroupMemberUntilSettled({
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
        // The failed account is no longer an enabled member: the session moves because it was revoked (spec A.4).
        ...(memberRevoked ? { replacementReason: 'member_revoked' as const } : {}),
        ...(state.requiredModelIds ? { requiredModelIds: state.requiredModelIds } : {}),
        ...(excluded.size > 0 ? { additionallyExcludedProfileIds: excluded } : {}),
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
    for (const superseded of [targetFailed ? pendingTarget.decisionId : null, ineligibleReplay?.decisionId ?? null]) {
      if (superseded && superseded !== decisionId) {
        this.deps.log?.('per_session_decision_superseded', { decisionId: superseded, supersededBy: decisionId, reason: targetFailed ? 'target_failed_before_adoption' : 'target_ineligible' });
        await this.deps.ledger.markSuperseded(superseded, decisionId, this.deps.nowMs());
      }
    }

    return await this.apply({
      input, sessionId, serviceId, state, failedProfileId,
      binding,
      materializedAssignment: {
        profileId: proposal.profileId,
        decisionId,
        reason: proposal.reason,
        ...(failedProfileId ? { fromProfileId: failedProfileId } : {}),
        materializedAtMs: this.deps.nowMs(),
        ...(Number.isFinite(proposal.temperature) ? { temperature: proposal.temperature } : {}),
        ...(Number.isFinite(proposal.offsetPercent) ? { offsetPercent: proposal.offsetPercent } : {}),
        ...(proposal.probability === null ? {} : { probability: proposal.probability }),
      },
      generation: state.generation,
    });
  }

  /**
   * Policy rollback (spec A.4 Migration, T12): a session that still owns a per-session assignment
   * converts at its next classified failure onto the group's current shared member and the group
   * home. Its applied `member` stays until provider adoption proves the conversion; the shared home
   * is never rewritten to match the session. If the shared member is itself the failed account, the
   * shared pipeline (without this session) moves the group pointer first.
   */
  private async convertToSharedGroup(params: Readonly<{
    input: ClassifiedFailureInput;
    sessionId: string;
    serviceId: ConnectedServiceId;
    binding: PerSessionSessionBinding;
    state: ConnectedServiceAuthGroupSwitchState;
    failedProfileId: string | null;
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const pending = params.binding.materializedAssignment;
    if (pending?.home === 'group' && pending.profileId !== params.failedProfileId) {
      return { status: 'switched', activeProfileId: pending.profileId, generation: params.state.generation, mode: 'restart_resume' };
    }
    let target = params.state.activeProfileId;
    let generation = params.state.generation;
    if (!target || target === params.failedProfileId) {
      const shared = await this.deps.switchSharedGroup({ ...params.input, sessionId: undefined });
      if (shared.status !== 'switched' || shared.activeProfileId === params.failedProfileId) return shared;
      target = shared.activeProfileId;
      generation = shared.generation;
    }
    return await this.apply({
      input: params.input,
      sessionId: params.sessionId,
      serviceId: params.serviceId,
      state: params.state,
      failedProfileId: params.failedProfileId,
      binding: params.binding,
      materializedAssignment: {
        profileId: target,
        decisionId: `conversion-${params.binding.subjectId}-${this.deps.nowMs().toString(36)}`,
        reason: 'policy_conversion',
        ...(params.failedProfileId ? { fromProfileId: params.failedProfileId } : {}),
        materializedAtMs: this.deps.nowMs(),
        home: 'group',
      },
      generation,
    });
  }

  private async apply(params: Readonly<{
    input: ClassifiedFailureInput;
    sessionId: string;
    serviceId: ConnectedServiceId;
    state: ConnectedServiceAuthGroupSwitchState;
    failedProfileId: string | null;
    binding: PerSessionSessionBinding;
    materializedAssignment: ConnectedServiceGroupMaterializedAssignmentV1;
    generation: number;
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const { input, binding, materializedAssignment } = params;
    const applied = await this.deps.applyAssignment({
      sessionId: params.sessionId,
      serviceId: params.serviceId,
      groupId: input.groupId,
      generation: params.generation,
      profileId: materializedAssignment.profileId,
      fromProfileId: params.failedProfileId,
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
        activeProfileId: materializedAssignment.profileId,
        generation: params.generation,
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
      activeProfileId: materializedAssignment.profileId,
      generation: params.generation,
      ...(mode ? { mode } : {}),
      ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
    };
  }
}
