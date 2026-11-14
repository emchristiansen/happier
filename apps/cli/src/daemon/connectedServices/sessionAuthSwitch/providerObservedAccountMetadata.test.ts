import { describe, expect, it } from 'vitest';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';
import {
  projectProviderObservedAccountMetadata,
  resolveAdoptedPerSessionDecisionId,
  resolveCommittedSharedConversion,
  resolveProvedSharedConversion,
} from './providerObservedAccountMetadata';

describe('provider-observed account metadata', () => {
  const binding = { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'fallback' };
  const metadata = { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': binding } }, other: 'preserved' };
  const observation = { serviceId: 'claude-subscription' as const, groupId: 'pool', profileId: 'observed' };

  it('publishes explicit applied account evidence without changing group fallback or selection', () => {
    const next = projectProviderObservedAccountMetadata(metadata, observation);
    expect(ConnectedServiceBindingsV1Schema.parse(next.connectedServices).bindingsByServiceId['claude-subscription']).toEqual({
      ...binding, appliedProfileId: 'observed',
    });
    expect(next.other).toBe('preserved');
    expect(metadata.connectedServices.bindingsByServiceId['claude-subscription']).toEqual(binding);
  });

  it('does not overwrite a changed selection or a missing binding', () => {
    expect(projectProviderObservedAccountMetadata(metadata, { ...observation, groupId: 'other' })).toBe(metadata);
    expect(projectProviderObservedAccountMetadata({}, observation)).toEqual({});
  });
});

describe('per-session adoption through provider-observed accounts', () => {
  const pending = {
    profileId: 'acct-b', decisionId: 'd-9', reason: 'failover' as const, fromProfileId: 'acct-a',
    materializedAtMs: 10, temperature: 1.5, offsetPercent: 10, probability: 0.4,
  };
  const metadata = {
    connectedServices: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected', selection: 'group', groupId: 'pool',
          member: { assignment: 'per_session', profileId: 'acct-a', decisionId: 'd-1', reason: 'initial_sampled', appliedAtMs: 1 },
          materializedAssignment: pending,
        },
      },
    },
  };

  it('promotes the pending target to the applied member only when the observed account matches', () => {
    const adopted = projectProviderObservedAccountMetadata(metadata, {
      serviceId: 'claude-subscription', groupId: 'pool', profileId: 'acct-b', observedAtMs: 99,
    });
    const binding = (adopted.connectedServices as any).bindingsByServiceId['claude-subscription'];
    expect(binding.materializedAssignment).toBeUndefined();
    expect(binding.appliedProfileId).toBe('acct-b');
    expect(binding.member).toEqual({
      assignment: 'per_session', profileId: 'acct-b', decisionId: 'd-9', reason: 'failover', fromProfileId: 'acct-a',
      appliedAtMs: 99, temperature: 1.5, offsetPercent: 10, probability: 0.4,
    });
    expect(resolveAdoptedPerSessionDecisionId(metadata, adopted, 'claude-subscription')).toBe('d-9');
  });

  it('keeps the pending target and the previous applied member when a different account is observed', () => {
    const observedOld = projectProviderObservedAccountMetadata(metadata, {
      serviceId: 'claude-subscription', groupId: 'pool', profileId: 'acct-a',
    });
    const binding = (observedOld.connectedServices as any).bindingsByServiceId['claude-subscription'];
    expect(binding.materializedAssignment).toEqual(pending);
    expect(binding.member.profileId).toBe('acct-a');
    expect(resolveAdoptedPerSessionDecisionId(metadata, observedOld, 'claude-subscription')).toBeNull();
  });
  it('ends per-session ownership only when a group-home conversion is proved by the observed account (T12)', () => {
    const converting = {
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
        source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'acct-b',
        member: { assignment: 'per_session', profileId: 'acct-b', decisionId: 'd-1', reason: 'initial_requested', appliedAtMs: 1 },
        materializedAssignment: { profileId: 'acct-a', decisionId: 'conversion-1', reason: 'policy_conversion', materializedAtMs: 2, home: 'group' },
      } } },
    };
    const stillOld = projectProviderObservedAccountMetadata(converting, { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'acct-b' });
    expect((stillOld.connectedServices as any).bindingsByServiceId['claude-subscription'].member.profileId).toBe('acct-b');

    const converted = projectProviderObservedAccountMetadata(converting, { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'acct-a' });
    expect((converted.connectedServices as any).bindingsByServiceId['claude-subscription']).toEqual({
      source: 'connected', selection: 'group', groupId: 'pool', appliedProfileId: 'acct-a',
    });
    expect(resolveAdoptedPerSessionDecisionId(converting, converted, 'claude-subscription')).toBeNull();
    // Only the matching group-home account proves conversion; the per-session decisions settle then (HPI-17).
    expect(resolveProvedSharedConversion(converting, converted, 'claude-subscription')).toBe(true);
    expect(resolveProvedSharedConversion(converting, stillOld, 'claude-subscription')).toBe(false);
    const wrongAccount = projectProviderObservedAccountMetadata(converting, { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'acct-c' });
    expect(resolveProvedSharedConversion(converting, wrongAccount, 'claude-subscription')).toBe(false);
    expect((wrongAccount.connectedServices as any).bindingsByServiceId['claude-subscription'].materializedAssignment)
      .toMatchObject({ decisionId: 'conversion-1', home: 'group' });

    // A repeated identical observation after the commit changes nothing but re-proves the
    // committed conversion, so settlement interrupted after the commit is not lost (HPI-17).
    const observedA = { serviceId: 'claude-subscription' as const, groupId: 'pool', profileId: 'acct-a' };
    expect(projectProviderObservedAccountMetadata(converted, observedA)).toBe(converted);
    expect(resolveCommittedSharedConversion(converted, observedA)).toBe(true);
    expect(resolveCommittedSharedConversion(converted, { ...observedA, profileId: 'acct-c' })).toBe(false);
    expect(resolveCommittedSharedConversion(converted, { ...observedA, groupId: 'other' })).toBe(false);
    expect(resolveCommittedSharedConversion(converting, observedA)).toBe(false);
    expect(resolveCommittedSharedConversion(wrongAccount, { ...observedA, profileId: 'acct-c' })).toBe(false);
  });
});
