import { z } from 'zod';

export const PendingQueueWakeUnavailableV1Schema = z.object({
  ok: z.literal(false),
  error: z.literal('pending_materialization_wake_unavailable'),
  errorCode: z.enum(['runtime_upgrade_required', 'runtime_terminating', 'publisher_lost']),
}).strict();

export const SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema = z.object({
  ok: z.literal(true),
  didMaterialize: z.literal(false),
  result: z.object({
    type: z.literal('deferred'),
    reason: z.literal('runtime_upgrade_required'),
  }).strict(),
}).strict();

export const SessionPendingQueueWakeCapabilityRequestV1Schema = z.object({}).strict();

export const SessionPendingQueueWakeCapabilityResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    capability: z.literal('pending_queue_wake_v1'),
    protocolVersion: z.literal(1),
    method: z.literal('session.pendingQueue.wake.v1'),
  }).strict(),
  PendingQueueWakeUnavailableV1Schema,
]);

export const SessionPendingQueueWakeRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
}).strict();

export const SessionPendingQueueWakeResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    result: z.literal('wake_published'),
  }).strict(),
  PendingQueueWakeUnavailableV1Schema,
]);

export type SessionPendingQueueLegacyMaterializeDeferredResponseV0 = z.infer<
  typeof SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema
>;
export type SessionPendingQueueWakeCapabilityResponseV1 = z.infer<
  typeof SessionPendingQueueWakeCapabilityResponseV1Schema
>;
export type SessionPendingQueueWakeResponseV1 = z.infer<typeof SessionPendingQueueWakeResponseV1Schema>;
