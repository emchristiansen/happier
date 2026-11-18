import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** Largest delay a JavaScript timer honours; longer values fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Steer an active runner at its next tool boundary without durable Pending custody.
 * The runner holds the message only for `waitMs`; nothing survives the call.
 */
export const SessionToolBoundarySteerRequestV1Schema = lazySchema(() => z.object({
  protocolVersion: z.literal(1),
  message: z.string().min(1),
  waitMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
}).strict());

/**
 * `written_to_hook_response` means a hook response carrying the message finished writing to its
 * forwarder; it is not proof the provider read it. Every `ok: false` code delivered nothing through
 * this call and is safe to retry.
 */
export const SessionToolBoundarySteerResponseV1Schema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    result: z.literal('written_to_hook_response'),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['no_tool_boundary', 'hook_response_lost', 'steering_unavailable']),
  }).strict(),
]));

export type SessionToolBoundarySteerRequestV1 = z.infer<typeof SessionToolBoundarySteerRequestV1Schema>;
export type SessionToolBoundarySteerResponseV1 = z.infer<typeof SessionToolBoundarySteerResponseV1Schema>;
