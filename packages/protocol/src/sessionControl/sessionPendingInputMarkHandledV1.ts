import { z } from 'zod';

import { PendingDeliveryBlockedReasonSchema } from '../sessionMessages/pendingDeliveryBlockedReason.js';
import { PendingLocalIdSchema } from '../sessionMessages/pendingLocalId.js';

/** Queued delivery states from which the server's handled route may resolve a pending row. */
export const SessionPendingInputMarkHandledExpectedDeliveryStateV1Schema = z.enum([
  'delivering',
  'external_handoff',
  'blocked',
]);
export type SessionPendingInputMarkHandledExpectedDeliveryStateV1 =
  z.infer<typeof SessionPendingInputMarkHandledExpectedDeliveryStateV1Schema>;

export const SessionPendingInputMarkHandledRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
    localId: PendingLocalIdSchema,
    expectedDeliveryState: SessionPendingInputMarkHandledExpectedDeliveryStateV1Schema,
    expectedBlockedReason: PendingDeliveryBlockedReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedBlockedReason !== undefined && value.expectedDeliveryState !== 'blocked') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedBlockedReason'],
        message: 'expectedBlockedReason requires expectedDeliveryState "blocked"',
      });
    }
  });
export type SessionPendingInputMarkHandledRequestV1 =
  z.infer<typeof SessionPendingInputMarkHandledRequestV1Schema>;

const NonNegativeIntegerSchema = z.number().int().nonnegative();

/** One pending row exactly as the server's pending list reported it. */
export const SessionPendingInputRowSnapshotV1Schema = z
  .object({
    localId: PendingLocalIdSchema,
    status: z.enum(['queued', 'discarded']),
    deliveryState: SessionPendingInputMarkHandledExpectedDeliveryStateV1Schema.nullable(),
    deliveryBlockedReason: z.string().min(1).nullable(),
    position: z.number().int(),
  })
  .strict();
export type SessionPendingInputRowSnapshotV1 = z.infer<typeof SessionPendingInputRowSnapshotV1Schema>;

/** An HTTP read or write that produced no usable answer. */
const SessionPendingInputHttpFailureV1Shape = {
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().min(1).nullable(),
} as const;

const SessionPendingInputMarkHandledExpectationV1Schema = z
  .object({
    deliveryState: SessionPendingInputMarkHandledExpectedDeliveryStateV1Schema,
    blockedReason: PendingDeliveryBlockedReasonSchema.nullable(),
  })
  .strict();

const SessionPendingInputMarkHandledRefusalV1Schema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('not_authenticated') }).strict(),
  z.object({ reason: z.literal('pre_read_failed'), ...SessionPendingInputHttpFailureV1Shape }).strict(),
  z.object({ reason: z.literal('row_missing') }).strict(),
  z.object({ reason: z.literal('state_mismatch'), row: SessionPendingInputRowSnapshotV1Schema }).strict(),
]);

/** Queue counters a response or readback may omit; each is null when it was not reported. */
const SessionPendingQueueCountsV1Shape = {
  pendingCount: NonNegativeIntegerSchema.nullable(),
  pendingBlockedCount: NonNegativeIntegerSchema.nullable(),
  pendingVersion: NonNegativeIntegerSchema.nullable(),
} as const;

/**
 * Queue counters of a not-resolved receipt. A handled response without a transcript message counts
 * as the server's answer that nothing was resolved only when it reports all three counters.
 */
const SessionPendingQueueCompleteCountsV1Shape = {
  pendingCount: NonNegativeIntegerSchema,
  pendingBlockedCount: NonNegativeIntegerSchema,
  pendingVersion: NonNegativeIntegerSchema,
} as const;

const SessionPendingInputMarkHandledReadbackV1Schema = z
  .object({
    pendingRows: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('read'),
        row: SessionPendingInputRowSnapshotV1Schema.nullable(),
        rowGoneFromQueuedList: z.boolean(),
      }).strict(),
      z.object({ status: z.literal('failed'), ...SessionPendingInputHttpFailureV1Shape }).strict(),
    ]),
    sessionCounts: z.discriminatedUnion('status', [
      z.object({ status: z.literal('read'), ...SessionPendingQueueCountsV1Shape }).strict(),
      z.object({ status: z.literal('failed'), ...SessionPendingInputHttpFailureV1Shape }).strict(),
    ]),
  })
  .strict();
export type SessionPendingInputMarkHandledReadbackV1 = z.infer<typeof SessionPendingInputMarkHandledReadbackV1Schema>;

/** Definite server refusals: the route answered and did not resolve the row. */
export const SessionPendingInputMarkHandledRejectionKindV1Schema = z.enum([
  'transcript_conflict',
  'invalid_params',
  'unauthenticated',
  'forbidden',
  'session_not_found',
  'other_client_error',
]);
export type SessionPendingInputMarkHandledRejectionKindV1 =
  z.infer<typeof SessionPendingInputMarkHandledRejectionKindV1Schema>;

/**
 * Failures after which the POST may or may not have taken effect: no HTTP answer at all, an HTTP
 * status that is not a final client rejection (5xx, timeouts, rate limits), or a success body
 * this client could not read.
 */
export const SessionPendingInputMarkHandledUncertaintyKindV1Schema = z.enum([
  'transport_failure',
  'non_final_status',
  'malformed_response',
]);
export type SessionPendingInputMarkHandledUncertaintyKindV1 =
  z.infer<typeof SessionPendingInputMarkHandledUncertaintyKindV1Schema>;

const SessionPendingInputMarkHandledReceiptBaseV1Shape = {
  sessionId: z.string().min(1),
  localId: PendingLocalIdSchema,
  expectation: SessionPendingInputMarkHandledExpectationV1Schema,
  /**
   * This action settles queue bookkeeping only. Proof that the input reached the provider is
   * the caller's to hold; no receipt from this action can assert it.
   */
  claimsDelivery: z.literal(false),
} as const;

const SessionPendingInputMarkHandledPostedReceiptV1Shape = {
  ...SessionPendingInputMarkHandledReceiptBaseV1Shape,
  preRead: SessionPendingInputRowSnapshotV1Schema,
  readback: SessionPendingInputMarkHandledReadbackV1Schema,
} as const;

export const SessionPendingInputMarkHandledResultV1Schema = z.discriminatedUnion('outcome', [
  z.object({
    ...SessionPendingInputMarkHandledReceiptBaseV1Shape,
    outcome: z.literal('refused'),
    refusal: SessionPendingInputMarkHandledRefusalV1Schema,
  }).strict(),
  z.object({
    ...SessionPendingInputMarkHandledPostedReceiptV1Shape,
    outcome: z.literal('resolved'),
    post: z.object({
      ...SessionPendingQueueCountsV1Shape,
      transcriptMessage: z.object({
        id: z.string().min(1),
        seq: NonNegativeIntegerSchema,
        localId: PendingLocalIdSchema,
        deliveryResolution: z.object({ v: z.literal(1), kind: z.literal('manual_handled') }).strict(),
      }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    ...SessionPendingInputMarkHandledPostedReceiptV1Shape,
    outcome: z.literal('not_resolved'),
    post: z.object(SessionPendingQueueCompleteCountsV1Shape).strict(),
  }).strict(),
  z.object({
    ...SessionPendingInputMarkHandledPostedReceiptV1Shape,
    outcome: z.literal('rejected'),
    post: z.object({
      errorKind: SessionPendingInputMarkHandledRejectionKindV1Schema,
      httpStatus: z.number().int(),
      serverError: z.string().min(1).nullable(),
    }).strict(),
  }).strict(),
  z.object({
    ...SessionPendingInputMarkHandledPostedReceiptV1Shape,
    outcome: z.literal('uncertain'),
    post: z.object({
      errorKind: SessionPendingInputMarkHandledUncertaintyKindV1Schema,
      ...SessionPendingInputHttpFailureV1Shape,
    }).strict(),
  }).strict(),
]);
export type SessionPendingInputMarkHandledResultV1 =
  z.infer<typeof SessionPendingInputMarkHandledResultV1Schema>;
