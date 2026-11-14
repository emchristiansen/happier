import { describe, expect, it } from 'vitest';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';
import { projectProviderObservedAccountMetadata, resolveAdoptedPerSessionDecisionId } from './providerObservedAccountMetadata';

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
});
