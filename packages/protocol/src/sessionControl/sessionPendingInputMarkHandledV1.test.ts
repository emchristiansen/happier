import { describe, expect, it } from 'vitest';

import {
  SessionPendingInputMarkHandledRequestV1Schema,
  SessionPendingInputMarkHandledResultV1Schema,
} from './sessionPendingInputMarkHandledV1.js';

const preRead = {
  localId: 'local-1',
  status: 'queued',
  deliveryState: 'blocked',
  deliveryBlockedReason: 'delivery_outcome_uncertain',
  position: 0,
} as const;

const expectation = {
  deliveryState: 'blocked',
  blockedReason: 'delivery_outcome_uncertain',
} as const;

const readback = {
  pendingRows: { status: 'read', row: null, rowGoneFromQueuedList: true },
  sessionCounts: { status: 'read', pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 8 },
} as const;

describe('session pending input mark-handled contract', () => {
  it('accepts an exact expected delivery state and keeps the local id bytes unchanged', () => {
    expect(SessionPendingInputMarkHandledRequestV1Schema.parse({
      sessionId: 'sess_1',
      localId: ' local-1 ',
      expectedDeliveryState: 'blocked',
      expectedBlockedReason: 'delivery_outcome_uncertain',
    })).toEqual({
      sessionId: 'sess_1',
      localId: ' local-1 ',
      expectedDeliveryState: 'blocked',
      expectedBlockedReason: 'delivery_outcome_uncertain',
    });

    for (const expectedDeliveryState of ['delivering', 'external_handoff', 'blocked'] as const) {
      expect(SessionPendingInputMarkHandledRequestV1Schema.safeParse({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState,
      }).success).toBe(true);
    }
  });

  it.each([
    ['blank session id', { sessionId: '  ', localId: 'local-1', expectedDeliveryState: 'blocked' }],
    ['blank local id', { sessionId: 'sess_1', localId: ' \t ', expectedDeliveryState: 'blocked' }],
    ['missing expected state', { sessionId: 'sess_1', localId: 'local-1' }],
    ['queued is not a handled-eligible state', { sessionId: 'sess_1', localId: 'local-1', expectedDeliveryState: 'queued' }],
    ['unknown blocked reason', {
      sessionId: 'sess_1', localId: 'local-1', expectedDeliveryState: 'blocked', expectedBlockedReason: 'future_reason',
    }],
    ['blocked reason without blocked state', {
      sessionId: 'sess_1', localId: 'local-1', expectedDeliveryState: 'delivering', expectedBlockedReason: 'unknown',
    }],
    ['unrecognized key', {
      sessionId: 'sess_1', localId: 'local-1', expectedDeliveryState: 'blocked', expectedBlockReason: 'unknown',
    }],
  ])('rejects %s', (_case, input) => {
    expect(SessionPendingInputMarkHandledRequestV1Schema.safeParse(input).success).toBe(false);
  });

  it('keeps refused, resolved, not-resolved, rejected and uncertain receipts distinct', () => {
    const base = { sessionId: 'sess_1', localId: 'local-1', expectation, claimsDelivery: false } as const;

    expect(SessionPendingInputMarkHandledResultV1Schema.parse({
      ...base,
      outcome: 'refused',
      refusal: { reason: 'state_mismatch', row: { ...preRead, deliveryState: 'delivering', deliveryBlockedReason: null } },
    }).outcome).toBe('refused');

    expect(SessionPendingInputMarkHandledResultV1Schema.parse({
      ...base,
      outcome: 'resolved',
      preRead,
      post: {
        pendingCount: 2,
        pendingBlockedCount: 0,
        pendingVersion: 8,
        transcriptMessage: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
      },
      readback,
    }).outcome).toBe('resolved');

    expect(SessionPendingInputMarkHandledResultV1Schema.parse({
      ...base,
      outcome: 'not_resolved',
      preRead,
      post: { pendingCount: 3, pendingBlockedCount: 1, pendingVersion: 7 },
      readback,
    }).outcome).toBe('not_resolved');

    expect(SessionPendingInputMarkHandledResultV1Schema.parse({
      ...base,
      outcome: 'rejected',
      preRead,
      post: { errorKind: 'transcript_conflict', httpStatus: 409, serverError: 'transcript-conflict' },
      readback,
    }).outcome).toBe('rejected');

    expect(SessionPendingInputMarkHandledResultV1Schema.parse({
      ...base,
      outcome: 'uncertain',
      preRead,
      post: { errorKind: 'transport_failure', httpStatus: null, errorCode: 'ECONNABORTED' },
      readback: {
        pendingRows: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' },
        sessionCounts: { status: 'failed', httpStatus: 503, errorCode: null },
      },
    }).outcome).toBe('uncertain');
  });

  describe('not-resolved post counts', () => {
    const notResolved = {
      sessionId: 'sess_1',
      localId: 'local-1',
      expectation,
      claimsDelivery: false,
      outcome: 'not_resolved',
      preRead,
      post: { pendingCount: 3, pendingBlockedCount: 1, pendingVersion: 7 },
      readback,
    } as const;

    it('accepts complete counts, including zeros', () => {
      expect(SessionPendingInputMarkHandledResultV1Schema.safeParse(notResolved).success).toBe(true);
      expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({
        ...notResolved,
        post: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 },
      }).success).toBe(true);
    });

    it.each([
      ['a null pending count', { pendingCount: null, pendingBlockedCount: 1, pendingVersion: 7 }],
      ['a null blocked count', { pendingCount: 3, pendingBlockedCount: null, pendingVersion: 7 }],
      ['a null pending version', { pendingCount: 3, pendingBlockedCount: 1, pendingVersion: null }],
      ['all counts null', { pendingCount: null, pendingBlockedCount: null, pendingVersion: null }],
      ['a missing blocked count', { pendingCount: 3, pendingVersion: 7 }],
      ['a negative count', { pendingCount: -1, pendingBlockedCount: 1, pendingVersion: 7 }],
      ['a fractional version', { pendingCount: 3, pendingBlockedCount: 1, pendingVersion: 7.5 }],
    ])('rejects %s', (_case, post) => {
      expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({ ...notResolved, post }).success).toBe(false);
    });

    it('keeps resolved post counts and session readback counts nullable', () => {
      expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({
        ...notResolved,
        outcome: 'resolved',
        post: {
          pendingCount: null,
          pendingBlockedCount: null,
          pendingVersion: null,
          transcriptMessage: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
      }).success).toBe(true);
      expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({
        ...notResolved,
        readback: {
          ...readback,
          sessionCounts: { status: 'read', pendingCount: null, pendingBlockedCount: null, pendingVersion: null },
        },
      }).success).toBe(true);
    });
  });

  it('cannot represent a receipt that claims delivery or a resolution without its transcript proof', () => {
    const resolved = {
      sessionId: 'sess_1',
      localId: 'local-1',
      expectation,
      outcome: 'resolved',
      preRead,
      post: {
        pendingCount: 2,
        pendingBlockedCount: 0,
        pendingVersion: 8,
        transcriptMessage: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
      },
      readback,
    } as const;

    expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({ ...resolved, claimsDelivery: false }).success).toBe(true);
    expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({ ...resolved, claimsDelivery: true }).success).toBe(false);
    expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({
      ...resolved,
      claimsDelivery: false,
      post: { pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 8 },
    }).success).toBe(false);
    expect(SessionPendingInputMarkHandledResultV1Schema.safeParse({
      ...resolved,
      claimsDelivery: false,
      outcome: 'refused',
      refusal: { reason: 'row_missing' },
    }).success).toBe(false);
  });
});
