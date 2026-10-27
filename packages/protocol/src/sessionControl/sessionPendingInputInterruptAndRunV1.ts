import { z } from 'zod';

import { PendingLocalIdSchema } from '../sessionMessages/pendingLocalId.js';

export const SessionPendingInputInterruptAndRunRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
    localId: PendingLocalIdSchema,
    expectedStateAtMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type SessionPendingInputInterruptAndRunRequestV1 =
  z.infer<typeof SessionPendingInputInterruptAndRunRequestV1Schema>;

export const SessionPendingInputInterruptAndRunResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.enum([
      'interrupted',
      'admitted_and_steered',
      'admitted_and_queued_until_boundary',
      'admitted_delivery_unobserved',
    ]),
    sessionId: z.string().min(1).optional(),
    localId: z.string().min(1).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    status: z.enum([
      'unsupported',
      'no_live_terminal',
      'stale_state',
      'not_safe',
      'capture_unavailable',
      'interrupt_failed',
    ]),
    sessionId: z.string().min(1).optional(),
    localId: z.string().min(1).optional(),
    errorCode: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).passthrough(),
]);
export type SessionPendingInputInterruptAndRunResultV1 =
  z.infer<typeof SessionPendingInputInterruptAndRunResultV1Schema>;

export function buildUnsupportedSessionPendingInputInterruptAndRunResult(
  sessionId: string,
  localId: string,
  method: string,
): SessionPendingInputInterruptAndRunResultV1 {
  return SessionPendingInputInterruptAndRunResultV1Schema.parse({
    ok: false,
    status: 'unsupported',
    sessionId,
    localId,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  });
}
