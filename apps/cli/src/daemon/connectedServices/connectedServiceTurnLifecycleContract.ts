import { ConnectedServiceIdSchema, PendingRequestedActionV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';
import { resolveAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { getRunnerPublisherIncarnationId, nextNativeProviderObservationSequence } from '@/api/session/publisherIncarnation';

import {
  TrackedSessionTurnLifecycleResultSchema,
  type TrackedSessionTurnLifecycleResult,
} from '../sessions/applyTrackedSessionTurnLifecycle';
import { lazySchema } from '@happier-dev/protocol';

export const NATIVE_PROVIDER_TURN_SOURCE_HEADER = 'x-happier-native-provider-source';

/**
 * Per-completion provenance for a completed terminal turn event, sent as a header so an older
 * daemon (strict body) ignores it. `claude_sdk_result_bound_v1`: the Claude Agent SDK runner
 * released this exact turn on a non-error, non-replayed result whose native attribution names the
 * turn's latest submitted prompt. Absent means no such binding (older runners, other providers,
 * unattributed or error results) and the completion is never qualified as useful provider work.
 */
export const TURN_COMPLETION_CONTRACT_HEADER = 'x-happier-turn-completion-contract';
export const TURN_COMPLETION_CONTRACTS = ['claude_sdk_result_bound_v1'] as const;
export type TurnCompletionContract = (typeof TURN_COMPLETION_CONTRACTS)[number];
export function readTurnCompletionContract(value: unknown): TurnCompletionContract | undefined {
  return TURN_COMPLETION_CONTRACTS.find((contract) => contract === value);
}
export const NativeProviderTurnSourceSchema = lazySchema(() => z.object({
  nativeId: z.string().min(1), pid: z.number().int().positive(),
  publisherIncarnationId: z.string().min(1),
  sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict());
export type NativeProviderTurnSource = z.infer<typeof NativeProviderTurnSourceSchema>;
export function nativeProviderSourceFromMetadata(metadata: unknown): NativeProviderTurnSource | undefined {
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  const nativeId = agentId ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata) : null;
  return nativeId ? { nativeId, pid: process.pid,
    publisherIncarnationId: getRunnerPublisherIncarnationId(), sequence: nextNativeProviderObservationSequence() } : undefined;
}
export function readNativeProviderTurnSource(value: unknown): NativeProviderTurnSource | undefined {
  if (typeof value !== 'string') return undefined;
  try { return NativeProviderTurnSourceSchema.safeParse(JSON.parse(value)).data; }
  catch { return undefined; }
}

export const ConnectedServiceTurnLifecycleRequestBodySchema = lazySchema(() => z.object({
  sessionId: z.string().min(1),
  event: z.enum([
    'prompt_or_steer',
    'task_started',
    'assistant_message_end',
    'turn_cancelled',
    'provider_identity_observed',
  ]),
  terminalStatus: z.enum(['completed', 'failed']).optional(),
  turnId: z.string().trim().min(1).max(512).optional(),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  activeTurnId: z.string().trim().min(1).max(512).nullable().optional(),
  providerIdentity: z.object({
    serviceId: ConnectedServiceIdSchema,
    groupId: z.string().trim().min(1),
    providerOrganizationId: z.string().trim().min(1).nullable(),
    observedAtMs: z.number().int().nonnegative(),
    sourceSessionId: z.string().trim().min(1),
    /**
     * Provenance of the evidence: the reporting runner's own process id and the home its launch
     * selection materialized (`group`: the group's shared home; `member`: one member's own home).
     * Per-session adoption and group-home conversion accept only the current runner's evidence for
     * the home and decision it was launched with; without provenance a report is account evidence only.
     */
    runnerPid: z.number().int().positive().optional(),
    launchHome: z.enum(['group', 'member']).optional(),
  }).strict().optional(),
}).strict());

export type ConnectedServiceTurnLifecycleRequestBody =
  z.infer<typeof ConnectedServiceTurnLifecycleRequestBodySchema>;

export const ConnectedServiceTurnLifecycleResultSchema =
  lazySchema(() => z.discriminatedUnion('status', [
    z.object({
      status: z.literal('continue'),
      turnCustody: TrackedSessionTurnLifecycleResultSchema,
    }).strict(),
    z.object({
      status: z.literal('input_blocked'),
      reason: z.literal('request_auth_source_cutover'),
    }).strict(),
  ]));

export type ConnectedServiceTurnLifecycleResult =
  z.infer<typeof ConnectedServiceTurnLifecycleResultSchema>;

export function connectedServiceTurnLifecycleContinue(
  turnCustody: TrackedSessionTurnLifecycleResult,
): ConnectedServiceTurnLifecycleResult {
  return {
    status: 'continue',
    turnCustody,
  };
}
