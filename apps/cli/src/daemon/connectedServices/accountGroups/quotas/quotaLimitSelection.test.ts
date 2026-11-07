import { describe, expect, it } from 'vitest';

import { includesConnectedServiceProviderLimit, shouldHandleConnectedServiceProviderLimitFailure } from './quotaLimitSelection';

describe('includesConnectedServiceProviderLimit', () => {
  it('accepts all limits by default and filters exact known allowance ids in selected mode', () => {
    expect(includesConnectedServiceProviderLimit(undefined, 'spark')).toBe(true);
    expect(includesConnectedServiceProviderLimit({ mode: 'all', providerLimitIds: [] }, 'spark')).toBe(true);
    expect(includesConnectedServiceProviderLimit({ mode: 'selected', providerLimitIds: ['standard'] }, 'standard')).toBe(true);
    expect(includesConnectedServiceProviderLimit({ mode: 'selected', providerLimitIds: ['standard'] }, 'spark')).toBe(false);
  });

  it('does not treat model-entitlement identities as quota allowance selections', () => {
    const selection = { mode: 'selected' as const, providerLimitIds: ['standard'] };
    expect(shouldHandleConnectedServiceProviderLimitFailure({ selection, reason: 'usage_limit', providerLimitId: 'spark' })).toBe(false);
    expect(shouldHandleConnectedServiceProviderLimitFailure({ selection, reason: 'plan_unavailable', providerLimitId: 'gpt-5.6-sol' })).toBe(true);
    expect(shouldHandleConnectedServiceProviderLimitFailure({ selection, reason: 'auth_expired', providerLimitId: 'credential' })).toBe(true);
  });

  it('keeps failures without an exact provider allowance identity eligible for existing recovery', () => {
    expect(includesConnectedServiceProviderLimit({ mode: 'selected', providerLimitIds: ['standard'] }, null)).toBe(true);
  });
});
