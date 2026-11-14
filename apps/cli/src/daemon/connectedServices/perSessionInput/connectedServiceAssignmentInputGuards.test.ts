import { describe, expect, it } from 'vitest';

import { CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS } from '@happier-dev/protocol';

import { resolveSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';

import {
  rejectConnectedServiceInternalAssignmentInput,
  restoreConnectedServicePerSessionAssignmentFromPersisted,
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

  const forgedValues: Record<string, unknown> = {
    member: { ...member, profileId: 'forged', decisionId: 'forged-decision' },
    materializedAssignment: { profileId: 'forged', decisionId: 'forged-decision', reason: 'initial_sampled', materializedAtMs: 1 },
    pendingAssignment: { profileId: 'forged' },
    decisionId: 'forged-decision',
  };
  const group = (groupId: string, extra: Record<string, unknown> = {}) => ({
    v: 1,
    bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId, ...extra } },
  });

  for (const field of CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS) {
    it(`rejects ${field} alone and strips it alone for inheritance (HPI-13)`, () => {
      expect(rejectConnectedServiceInternalAssignmentInput(group('pool', { [field]: forgedValues[field] }))?.fields)
        .toEqual([`claude-subscription.${field}`]);
      expect(stripConnectedServicePerSessionAssignmentForInheritance(group('pool', { [field]: forgedValues[field] }))).toEqual(group('pool'));
    });

    it(`resume drops caller ${field} when the persisted session owns no assignment (HPI-04)`, () => {
      const incoming = group('pool', { [field]: forgedValues[field] });
      expect(restoreConnectedServicePerSessionAssignmentFromPersisted(incoming, undefined)).toEqual(group('pool'));
      expect(restoreConnectedServicePerSessionAssignmentFromPersisted(incoming, group('pool'))).toEqual(group('pool'));
      expect(restoreConnectedServicePerSessionAssignmentFromPersisted(incoming, { v: 1, bindingsByServiceId: {} })).toEqual(group('pool'));
    });
  }

  it('resume does not restore another group\'s persisted assignment, and still drops the caller\'s', () => {
    const own = { ...member, profileId: 'own', decisionId: 'own-decision' };
    expect(restoreConnectedServicePerSessionAssignmentFromPersisted(
      group('pool-b', { member: forgedValues.member }),
      group('pool-a', { member: own }),
    )).toEqual(group('pool-b'));
  });

  it('positive control: resume replaces a forged member with the session\'s own member for the same group', () => {
    const own = { ...member, profileId: 'own', decisionId: 'own-decision' };
    const ownPending = { profileId: 'next', decisionId: 'own-next', reason: 'failover', materializedAtMs: 2 };
    expect(restoreConnectedServicePerSessionAssignmentFromPersisted(
      group('pool', { member: forgedValues.member, decisionId: 'forged-decision' }),
      group('pool', { member: own, materializedAssignment: ownPending }),
    )).toEqual(group('pool', { member: own, materializedAssignment: ownPending }));
  });

  it('positive control: resume keeps the caller\'s initialProfileId request', () => {
    expect(restoreConnectedServicePerSessionAssignmentFromPersisted(group('pool', { initialProfileId: 'a' }), undefined))
      .toEqual(group('pool', { initialProfileId: 'a' }));
  });

  it('a newer incoming snapshot cannot carry a forged member through snapshot selection + restore (reviewer INPUT-1)', () => {
    const persisted = { flavor: 'claude', connectedServices: group('pool'), connectedServicesUpdatedAt: 1 };
    const snapshot = resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/project',
        existingSessionId: 'same-session',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: group('pool', { member: forgedValues.member }),
        connectedServicesUpdatedAt: 2,
      } as never,
      persistedMetadata: persisted as never,
    });
    expect(restoreConnectedServicePerSessionAssignmentFromPersisted(snapshot.spawnOptions.connectedServices, persisted.connectedServices))
      .toEqual(group('pool'));
  });
});
