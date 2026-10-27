import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PendingRequestedActionV1Schema } from './pendingRequestedActionV1.js';

describe('PendingRequestedActionV1Schema', () => {
  it.each(['enqueue', 'steer_if_active', 'steer_now', 'send_now'] as const)(
    'accepts the canonical %s row action without duplicating row identity',
    (kind) => {
      expect(PendingRequestedActionV1Schema.parse({ v: 1, kind })).toEqual({ v: 1, kind });
    },
  );

  it('requires a strict opaque invocation binding for bound steering', () => {
    const action = { v: 1, kind: 'steer_now_bound', bindingId: ' binding-1 ' };
    expect(PendingRequestedActionV1Schema.parse(action)).toEqual(action);
    for (const bindingId of [undefined, null, '', '   ', 1]) {
      expect(PendingRequestedActionV1Schema.safeParse({ ...action, bindingId }).success).toBe(false);
    }
    expect(PendingRequestedActionV1Schema.safeParse({ ...action, turnId: 'T2' }).success).toBe(false);
    expect(PendingRequestedActionV1Schema.safeParse({ ...action, v: 2 }).success).toBe(false);
    expect(PendingRequestedActionV1Schema.safeParse({ v: 1, kind: 'steer_now', bindingId: 'B1' }).success).toBe(false);
  });

  it('fails closed in the exact c777 predecessor action schema while preserving its four controls', () => {
    // Retained verbatim schema contract: c7771d76711b6c360d82d336bd8b84f398888174,
    // packages/protocol/src/sessionMessages/pendingRequestedActionV1.ts:8-11.
    const predecessor = z.object({
      v: z.literal(1),
      kind: z.enum(['enqueue', 'steer_if_active', 'steer_now', 'send_now']),
    }).strict();
    expect(predecessor.safeParse({ v: 1, kind: 'steer_now_bound', bindingId: 'B1' }).success).toBe(false);
    for (const kind of ['enqueue', 'steer_if_active', 'steer_now', 'send_now']) {
      expect(predecessor.parse({ v: 1, kind })).toEqual({ v: 1, kind });
    }
  });

  it('rejects the removed exact-dispatch selector and command shape', () => {
    expect(PendingRequestedActionV1Schema.safeParse({
      v: 1,
      kind: 'send_now',
      selector: { kind: 'exact_target', localId: 'pending-1' },
      deliveryCommand: 'interrupt_and_send',
    }).success).toBe(false);
  });
});
