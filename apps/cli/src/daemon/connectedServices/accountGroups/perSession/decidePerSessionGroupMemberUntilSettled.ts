import {
  decidePerSessionGroupMember,
  type DecidePerSessionGroupMemberInput,
  type PerSessionAssignmentDecision,
} from './decidePerSessionGroupMember';

/** Pause between reconciliation attempts of one unsettled reservation (bounded by the caller's deadline). */
export const PER_SESSION_CUSTODY_RETRY_INTERVAL_MS = 1_000;

export type SettledPerSessionAssignmentDecision = Exclude<PerSessionAssignmentDecision, { kind: 'custody_unresolved' }>;

/**
 * Runs one decision through R4 within the caller's existing deadline (spec A.5): while an unsettled
 * reservation cannot be reconciled, the same durable proposal is retried under the SAME deadline, so
 * no effect happens before either reconciliation or that deadline. At the deadline the decision
 * resolves to `reservation_uncertain` on the same ID and target.
 */
export async function decidePerSessionGroupMemberUntilSettled(
  input: DecidePerSessionGroupMemberInput,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SettledPerSessionAssignmentDecision> {
  let decision = await decidePerSessionGroupMember(input);
  while (decision.kind === 'custody_unresolved') {
    const remainingMs = decision.deadlineAtMs - input.nowMs();
    if (remainingMs > 0) await wait(Math.min(PER_SESSION_CUSTODY_RETRY_INTERVAL_MS, remainingMs));
    decision = await decidePerSessionGroupMember({
      ...input,
      resumeProposal: decision.pendingProposal,
      deadlineAtMs: decision.deadlineAtMs,
    });
  }
  return decision;
}
