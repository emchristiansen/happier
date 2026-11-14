import { describe, expect, it } from 'vitest';

import { readPerSessionSessionBinding } from './readPerSessionSessionBinding';

const tracked = (binding: Record<string, unknown>) => ({
  happySessionId: 'sess-1',
  happySessionMetadataFromLocalWebhook: {
    connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', ...binding } } },
  },
});
const member = { assignment: 'per_session', profileId: 'a', decisionId: 'd-a', reason: 'initial_sampled', appliedAtMs: 1 };
const pendingB = { profileId: 'b', decisionId: 'd-b', reason: 'initial_sampled', materializedAtMs: 2 };

describe('readPerSessionSessionBinding serving identity (T19)', () => {
  it('has no proved serving account for a pending-only first spawn', () => {
    expect(readPerSessionSessionBinding(tracked({ materializedAssignment: pendingB }), 'claude-subscription', 'pool')?.currentProfileId).toBeNull();
  });

  it('keeps the previous applied member while a failover target is pending', () => {
    expect(readPerSessionSessionBinding(tracked({ member, materializedAssignment: { ...pendingB, reason: 'failover' } }), 'claude-subscription', 'pool')?.currentProfileId).toBe('a');
  });

  it('uses the applied member, and the applied account of a shared session', () => {
    expect(readPerSessionSessionBinding(tracked({ member }), 'claude-subscription', 'pool')?.currentProfileId).toBe('a');
    expect(readPerSessionSessionBinding(tracked({ appliedProfileId: 'c' }), 'claude-subscription', 'pool')?.currentProfileId).toBe('c');
  });
});
