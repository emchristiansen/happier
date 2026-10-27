import { describe, expect, it } from 'vitest';

import { PendingLocalIdSchema } from '../sessionMessages/pendingLocalId.js';
import { SessionPendingInputInterruptAndRunRequestV1Schema } from './sessionPendingInputInterruptAndRunV1.js';

describe('session pending input interrupt-and-run request identity', () => {
  it('preserves distinct canonical opaque pending identities', () => {
    const localIds = ['x', ' x '];
    const parsedLocalIds = localIds.map((localId) => {
      expect(PendingLocalIdSchema.parse(localId)).toBe(localId);
      return SessionPendingInputInterruptAndRunRequestV1Schema.parse({
        sessionId: 'session-1',
        localId,
      }).localId;
    });

    expect(parsedLocalIds).toEqual(localIds);
    expect(new Set(parsedLocalIds).size).toBe(2);
  });

  it.each(['', ' ', '\t\r\n', '\u2003'])('rejects a blank localId at index %#', (localId) => {
    expect(SessionPendingInputInterruptAndRunRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId,
    }).success).toBe(false);
  });
});
