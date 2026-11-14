import { describe, expect, it } from 'vitest';

import {
    appendConnectedServiceAuthGroupReaderCapabilities,
    ConnectedServiceAssignmentReservationConflictResponseV1Schema,
    ConnectedServiceAssignmentReservationPutRequestV1Schema,
    ConnectedServiceAuthGroupErrorCodeV1Schema,
    ConnectedServiceAuthGroupPolicyPatchV1Schema,
    ConnectedServiceAuthGroupPolicyV1Schema,
    ConnectedServiceBindingsV1Schema,
    stripConnectedServicePerSessionAssignmentFields,
    CONNECTED_SERVICE_POOL_PER_SESSION_SOFTMAX_QUERY_KEY,
    findConnectedServiceInternalAssignmentFields,
} from './connectedServiceSchemas.js';

describe('per_session_softmax policy schema', () => {
    it('accepts the strategy and leaves temperature/offset absent by default', () => {
        const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax' });
        expect(policy.strategy).toBe('per_session_softmax');
        expect(policy).not.toHaveProperty('softmaxTemperature');
        expect(policy).not.toHaveProperty('softmaxOffsetPercent');
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({})).not.toHaveProperty('softmaxTemperature');
    });

    it('validates temperature in 0.25..10 and offset in 0.1..100 (offset zero is singular)', () => {
        const parse = (fields: Record<string, unknown>) =>
            ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ strategy: 'per_session_softmax', ...fields }).success;
        expect(parse({ softmaxTemperature: 1.5, softmaxOffsetPercent: 10 })).toBe(true);
        expect(parse({ softmaxTemperature: 0.25, softmaxOffsetPercent: 0.1 })).toBe(true);
        expect(parse({ softmaxTemperature: 10, softmaxOffsetPercent: 100 })).toBe(true);
        expect(parse({ softmaxOffsetPercent: 0 })).toBe(false);
        expect(parse({ softmaxOffsetPercent: -1 })).toBe(false);
        expect(parse({ softmaxTemperature: 0.2 })).toBe(false);
        expect(parse({ softmaxTemperature: Number.POSITIVE_INFINITY })).toBe(false);
        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.safeParse({ softmaxTemperature: 2 }).success).toBe(true);
        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.safeParse({ softmaxOffsetPercent: 0 }).success).toBe(false);
    });

    it('defines the new error codes', () => {
        for (const code of [
            'connect_group_policy_field_invalid_for_strategy',
            'connect_group_policy_field_out_of_range',
            'connect_group_strategy_unsupported_for_service',
            'connect_group_policy_requires_capability',
            'assignment_reservation_conflict',
            'assignment_reservation_decision_mismatch',
        ]) {
            expect(ConnectedServiceAuthGroupErrorCodeV1Schema.safeParse(code).success).toBe(true);
        }
    });

    it('advertises the per-session reader capability', () => {
        expect(appendConnectedServiceAuthGroupReaderCapabilities('/v3/connect/claude-subscription/groups'))
            .toContain(`${CONNECTED_SERVICE_POOL_PER_SESSION_SOFTMAX_QUERY_KEY}=1`);
    });
});

describe('assignment reservation schemas', () => {
    it('requires the expected revision on PUT and strict conflict bodies', () => {
        expect(ConnectedServiceAssignmentReservationPutRequestV1Schema.safeParse({
            profileId: 'a', sessionId: 's', ownerMachineId: 'm', state: 'pending', leaseUntilMs: 1,
        }).success).toBe(false);
        expect(ConnectedServiceAssignmentReservationPutRequestV1Schema.safeParse({
            profileId: 'a', sessionId: 's', ownerMachineId: 'm', state: 'pending', leaseUntilMs: 1, expectedReservationRevision: 0,
        }).success).toBe(true);
        expect(ConnectedServiceAssignmentReservationConflictResponseV1Schema.safeParse({
            error: 'assignment_reservation_conflict', reservationRevision: 3, reservations: [],
        }).success).toBe(true);
    });
});

describe('group binding assignment fields', () => {
    it('accepts initialProfileId and an internal member assignment', () => {
        const bindings = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': {
                    source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'acct-a',
                    member: {
                        assignment: 'per_session', profileId: 'acct-a', decisionId: 'd1', reason: 'initial_requested',
                        appliedAtMs: 5, temperature: 1.5, offsetPercent: 10, probability: 1,
                    },
                },
            },
        });
        expect(bindings.bindingsByServiceId['claude-subscription']).toMatchObject({ initialProfileId: 'acct-a' });
    });

    it('rejects a malformed internal member assignment', () => {
        expect(ConnectedServiceBindingsV1Schema.safeParse({
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': {
                    source: 'connected', selection: 'group', groupId: 'pool',
                    member: { assignment: 'shared', profileId: 'acct-a' },
                },
            },
        }).success).toBe(false);
    });

    it('finds internal assignment fields supplied by external callers', () => {
        expect(findConnectedServiceInternalAssignmentFields({
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', member: {}, decisionId: 'x' },
                'openai-codex': { source: 'native' },
            },
        })).toEqual(['claude-subscription.member', 'claude-subscription.decisionId']);
        expect(findConnectedServiceInternalAssignmentFields({
            'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a' },
        })).toEqual([]);
        expect(findConnectedServiceInternalAssignmentFields(null)).toEqual([]);
    });

  it('strips per-session request and assignment for inheritance, keeping group and source', () => {
    const bindings = ConnectedServiceBindingsV1Schema.parse({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a',
          member: { assignment: 'per_session', profileId: 'a', decisionId: 'd', reason: 'initial_requested', appliedAtMs: 1 },
        },
      },
    });
    expect(stripConnectedServicePerSessionAssignmentFields(bindings)).toEqual({
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
    });
    const plain = ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'native' } } });
    expect(stripConnectedServicePerSessionAssignmentFields(plain)).toBe(plain);
  });
});

