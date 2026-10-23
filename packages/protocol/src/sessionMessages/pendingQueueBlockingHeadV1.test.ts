import { describe, expect, it } from 'vitest';

import { V2SessionRecordSchema } from '../sessionControl/contract';
import { PendingQueueBlockingHeadV1Schema, readPendingQueueBlockingHeadV1 } from './pendingQueueBlockingHeadV1';

const blocked = {
  localId: 'head-1',
  deliveryState: 'blocked',
  blockedReason: 'delivery_outcome_uncertain',
  lastUpdatedAt: 1_700_000_000_000,
  ageSinceLastUpdateMs: 45_000,
} as const;

describe('pending queue blocking head contract', () => {
  it('accepts each head kind that holds ordinary rows back', () => {
    expect(PendingQueueBlockingHeadV1Schema.parse(blocked)).toEqual(blocked);
    for (const deliveryState of ['delivering', 'external_handoff'] as const) {
      const head = { localId: 'head-2', deliveryState, lastUpdatedAt: 1, ageSinceLastUpdateMs: 0 };
      expect(PendingQueueBlockingHeadV1Schema.parse(head)).toEqual(head);
    }
  });

  it('requires a blocked reason exactly when the head is blocked', () => {
    expect(PendingQueueBlockingHeadV1Schema.safeParse({ ...blocked, blockedReason: undefined }).success).toBe(false);
    expect(PendingQueueBlockingHeadV1Schema.safeParse({
      localId: 'head-2',
      deliveryState: 'delivering',
      blockedReason: 'delivery_outcome_uncertain',
      lastUpdatedAt: 1,
      ageSinceLastUpdateMs: 0,
    }).success).toBe(false);
  });

  it('rejects a queued head, a blank localId and negative or fractional times', () => {
    for (const value of [
      { ...blocked, deliveryState: 'queued' },
      { ...blocked, localId: '' },
      { ...blocked, lastUpdatedAt: -1 },
      { ...blocked, ageSinceLastUpdateMs: 1.5 },
    ]) {
      expect(readPendingQueueBlockingHeadV1(value)).toBeNull();
    }
  });

  it('keeps a session record readable when its reported head is malformed, dropping only the head', () => {
    const record = {
      id: 's1',
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: 'm',
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
    };
    expect(V2SessionRecordSchema.parse({ ...record, pendingQueueBlockingHead: blocked }).pendingQueueBlockingHead)
      .toEqual(blocked);
    expect(V2SessionRecordSchema.parse({ ...record, pendingQueueBlockingHead: null }).pendingQueueBlockingHead)
      .toBeNull();
    const malformed = V2SessionRecordSchema.parse({ ...record, pendingQueueBlockingHead: { localId: 'x' } });
    expect(malformed.id).toBe('s1');
    expect(malformed.pendingQueueBlockingHead).toBeUndefined();
  });
});
