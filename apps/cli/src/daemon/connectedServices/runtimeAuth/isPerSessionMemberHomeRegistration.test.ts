import { describe, expect, it } from 'vitest';

import { isPerSessionMemberHomeRegistration } from './isPerSessionMemberHomeRegistration';

const binding = { serviceId: 'claude-subscription' as const, groupId: 'pool', profileId: 'alpha', generation: null, credentialRevision: null };
const profileSelection = { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'alpha', credentialRevision: null };
const groupBinding = (extra: Record<string, unknown>) => ({ v: 1, bindingsByServiceId: { 'claude-subscription': {
  source: 'connected', selection: 'group', groupId: 'pool', ...extra } } });
const member = { member: { assignment: 'per_session', profileId: 'alpha', decisionId: 'd1', reason: 'initial_sampled', appliedAtMs: 1 } };
const pending = { materializedAssignment: { profileId: 'alpha', decisionId: 'd1', reason: 'initial_sampled', materializedAtMs: 1 } };

describe('per-session member-home registration (FAILOVER-SRC-01)', () => {
  it.each([['an applied member', member], ['a materialized target', pending]])('recognizes a profile launch inside the group with %s', (_label, assignment) => {
    expect(isPerSessionMemberHomeRegistration({ binding, selections: [profileSelection], bindingsRaw: groupBinding(assignment) })).toBe(true);
  });

  it.each([
    ['a shared group generation', { binding: { ...binding, generation: 3 }, selections: [profileSelection], bindingsRaw: groupBinding(member) }],
    ['no group', { binding: { ...binding, groupId: null }, selections: [profileSelection], bindingsRaw: groupBinding(member) }],
    ['a group selection', { binding, selections: [{ ...profileSelection, kind: 'group', groupId: 'pool', activeProfileId: 'alpha', fallbackProfileId: 'alpha', generation: 3 }], bindingsRaw: groupBinding(member) }],
    ['another profile selected', { binding, selections: [{ ...profileSelection, profileId: 'beta' }], bindingsRaw: groupBinding(member) }],
    ['no selection', { binding, selections: [], bindingsRaw: groupBinding(member) }],
    ['no per-session ownership', { binding, selections: [profileSelection], bindingsRaw: groupBinding({}) }],
    ['another session group', { binding, selections: [profileSelection], bindingsRaw: { bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'other', ...member } } } }],
    ['no session binding', { binding, selections: [profileSelection], bindingsRaw: null }],
  ] as const)('does not recognize %s', (_label, input) => {
    expect(isPerSessionMemberHomeRegistration(input as any)).toBe(false);
  });
});
