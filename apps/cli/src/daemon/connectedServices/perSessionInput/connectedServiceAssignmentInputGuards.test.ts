import { describe, expect, it } from 'vitest';

import {
  rejectConnectedServiceInternalAssignmentInput,
  stripConnectedServicePerSessionAssignmentForInheritance,
} from './connectedServiceAssignmentInputGuards';

const member = { assignment: 'per_session', profileId: 'a', decisionId: 'd1', reason: 'initial_sampled', appliedAtMs: 1 };

describe('connected-service assignment input guards', () => {
  it('rejects forged member and pending assignment state with the spec error (T15)', () => {
    const rejection = rejectConnectedServiceInternalAssignmentInput({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', member, materializedAssignment: { profileId: 'b' } },
      },
    });
    expect(rejection).toMatchObject({
      errorCode: 'connected_service_internal_assignment_field_forbidden',
      fields: ['claude-subscription.member', 'claude-subscription.materializedAssignment'],
    });
  });

  it('accepts an external initialProfileId request', () => {
    expect(rejectConnectedServiceInternalAssignmentInput({
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a' } },
    })).toBeNull();
  });

  it('strips the parent request and assignment for a child, fork or default, keeping group and source', () => {
    const stripped = stripConnectedServicePerSessionAssignmentForInheritance({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a', member, materializedAssignment: { profileId: 'b' } },
        'openai-codex': { source: 'native' },
      },
    });
    expect(stripped).toEqual({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' },
        'openai-codex': { source: 'native' },
      },
    });
  });

  it('returns the identical object when nothing is inherited per-session', () => {
    const plain = { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } } };
    expect(stripConnectedServicePerSessionAssignmentForInheritance(plain)).toBe(plain);
  });
});
