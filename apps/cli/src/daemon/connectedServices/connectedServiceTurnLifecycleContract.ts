import { PendingRequestedActionV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';
import { resolveAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { getRunnerPublisherIncarnationId, nextNativeProviderObservationSequence } from '@/api/session/publisherIncarnation';

import {
  TrackedSessionTurnLifecycleResultSchema,
  type TrackedSessionTurnLifecycleResult,
} from '../sessions/applyTrackedSessionTurnLifecycle';

export const NATIVE_PROVIDER_TURN_SOURCE_HEADER = 'x-happier-native-provider-source';
export const NativeProviderTurnSourceSchema = z.object({
  nativeId: z.string().min(1), pid: z.number().int().positive(),
  publisherIncarnationId: z.string().min(1),
  sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict();
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

export const ConnectedServiceTurnLifecycleRequestBodySchema = z.object({
  sessionId: z.string().min(1),
  event: z.enum([
    'prompt_or_steer',
    'task_started',
    'assistant_message_end',
    'turn_cancelled',
  ]),
  terminalStatus: z.enum(['completed', 'failed']).optional(),
  turnId: z.string().trim().min(1).max(512).optional(),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  activeTurnId: z.string().trim().min(1).max(512).nullable().optional(),
}).strict();

export type ConnectedServiceTurnLifecycleRequestBody =
  z.infer<typeof ConnectedServiceTurnLifecycleRequestBodySchema>;

export const ConnectedServiceTurnLifecycleResultSchema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('continue'),
      turnCustody: TrackedSessionTurnLifecycleResultSchema,
    }).strict(),
    z.object({
      status: z.literal('input_blocked'),
      reason: z.literal('request_auth_source_cutover'),
    }).strict(),
  ]);

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
