import { z } from 'zod';

/**
 * The runtime incarnation of the runner process that answered: its machine, its pid, and the
 * process-instance fingerprint `readProcessInstanceFingerprintSync` reads for that pid. A daemon
 * acts destructively on a report only when this equals the exact local process it would stop.
 */
export const PendingQueueWakeRunnerIncarnationV1Schema = z.object({
  machineId: z.string().min(1).max(512),
  pid: z.number().int().positive(),
  processInstanceFingerprint: z.string().min(1).max(512),
}).strict();

const pendingQueueWakeUnavailableV1Shape = {
  ok: z.literal(false),
  error: z.literal('pending_materialization_wake_unavailable'),
} as const;

export const PendingQueueWakeUnavailableV1Schema = z.union([
  z.object({
    ...pendingQueueWakeUnavailableV1Shape,
    errorCode: z.enum(['runtime_upgrade_required', 'runtime_terminating', 'publisher_recovering']),
  }).strict(),
  // Terminal publisher loss names its reporting incarnation. It is optional on the wire because a
  // runner that cannot identify itself still reports the loss; such a report authorizes nothing.
  z.object({
    ...pendingQueueWakeUnavailableV1Shape,
    errorCode: z.literal('publisher_lost'),
    respondent: PendingQueueWakeRunnerIncarnationV1Schema.optional(),
  }).strict(),
]);

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

export type PendingQueueWakeRunnerIncarnationV1 = z.infer<typeof PendingQueueWakeRunnerIncarnationV1Schema>;
export type SessionPendingQueueLegacyMaterializeDeferredResponseV0 = z.infer<
  typeof SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema
>;
export type SessionPendingQueueWakeCapabilityResponseV1 = z.infer<
  typeof SessionPendingQueueWakeCapabilityResponseV1Schema
>;
export type SessionPendingQueueWakeResponseV1 = z.infer<typeof SessionPendingQueueWakeResponseV1Schema>;
