import { z } from 'zod';
import { PendingLocalIdSchema } from './pendingLocalId.js';

/**
 * The single server-owned action persisted on one Pending row.
 *
 * The row already owns sessionId + localId, so this value deliberately carries no selector.
 */
export const PendingRequestedActionV1Schema = z.union([
  z.object({
    v: z.literal(1),
    kind: z.enum(['enqueue', 'steer_if_active', 'steer_now', 'send_now']),
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('steer_now_bound'),
    // Opaque invocation identity, resolved only by the originating Codex runtime.
    bindingId: PendingLocalIdSchema,
  }).strict(),
]);

export type PendingRequestedActionV1 = z.infer<typeof PendingRequestedActionV1Schema>;
