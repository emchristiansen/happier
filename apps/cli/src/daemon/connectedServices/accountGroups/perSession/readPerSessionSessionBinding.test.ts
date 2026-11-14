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

  it('reports the current runner process, not launch options, as the session\'s runner (HPI-21)', () => {
    expect(readPerSessionSessionBinding({ ...tracked({ member }), pid: 42, processInstanceFingerprint: 'fp' }, 'claude-subscription', 'pool')?.runner)
      .toEqual({ pid: 42, processInstanceFingerprint: 'fp' });
    expect(readPerSessionSessionBinding(tracked({ member }), 'claude-subscription', 'pool')?.runner).toBeUndefined();
  });

  it('never pairs the launcher pid with a wrapper child\'s reported fingerprint (HPI-31)', () => {
    const wrapped = { ...tracked({ member }), pid: 42, sessionRunnerPid: 43, processInstanceFingerprint: 'fp-reporter-43' };
    expect(readPerSessionSessionBinding(wrapped, 'claude-subscription', 'pool')?.runner).toEqual({ pid: 42 });
    expect(readPerSessionSessionBinding({ ...wrapped, sessionRunnerPid: 42 }, 'claude-subscription', 'pool')?.runner)
      .toEqual({ pid: 42, processInstanceFingerprint: 'fp-reporter-43' });
  });

  it('reads the decisions the runner was launched with from its spawn-site record, never metadata (HPI-31/32)', () => {
    const launchedWith = (binding: Record<string, unknown>) => ({ v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', ...binding } } });
    // Metadata already names the pending target; the runner was launched before it existed.
    const committed = tracked({ member, materializedAssignment: { ...pendingB, reason: 'failover' } });
    expect(readPerSessionSessionBinding({ ...committed, launchedConnectedServices: launchedWith({ member }) }, 'claude-subscription', 'pool')?.runnerLaunchedDecisionIds)
      .toEqual(['d-a']);
    expect(readPerSessionSessionBinding({ ...committed, launchedConnectedServices: launchedWith({ member, materializedAssignment: pendingB }) }, 'claude-subscription', 'pool')?.runnerLaunchedDecisionIds)
      .toEqual(['d-a', 'd-b']);
    expect(readPerSessionSessionBinding(committed, 'claude-subscription', 'pool')?.runnerLaunchedDecisionIds).toBeUndefined();
  });
});
