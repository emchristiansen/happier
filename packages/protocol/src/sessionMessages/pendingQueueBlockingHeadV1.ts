import { z } from 'zod';

import { PendingDeliveryBlockedReasonSchema } from './pendingDeliveryBlockedReason.js';

const blockingHeadCommonShape = {
  localId: z.string().min(1),
  /**
   * The row's last update (epoch ms). Rows record no instant at which they became blocked or
   * delivering, so this is the closest recorded instant, not the start of the block.
   */
  lastUpdatedAt: z.number().int().nonnegative(),
  /** Server time minus `lastUpdatedAt` when the server reported the head. */
  ageSinceLastUpdateMs: z.number().int().nonnegative(),
} as const;

/**
 * The oldest queued pending row that holds ordinary rows back, as the server reports it. A head
 * blocked as `unsupported_action` (or a queued row the server projects that way) never appears
 * here: ordinary rows pass it, because it can never be delivered. Reporting a head changes nothing
 * about it; resolving it is a separate, explicit act.
 */
export const PendingQueueBlockingHeadV1Schema = z.discriminatedUnion('deliveryState', [
  z.object({
    ...blockingHeadCommonShape,
    deliveryState: z.literal('blocked'),
    blockedReason: PendingDeliveryBlockedReasonSchema,
  }),
  z.object({
    ...blockingHeadCommonShape,
    deliveryState: z.literal('delivering'),
    blockedReason: z.undefined().optional(),
  }),
  z.object({
    ...blockingHeadCommonShape,
    deliveryState: z.literal('external_handoff'),
    blockedReason: z.undefined().optional(),
  }),
]);

export type PendingQueueBlockingHeadV1 = z.infer<typeof PendingQueueBlockingHeadV1Schema>;

export function readPendingQueueBlockingHeadV1(value: unknown): PendingQueueBlockingHeadV1 | null {
  const parsed = PendingQueueBlockingHeadV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
