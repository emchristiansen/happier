import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaMeterV1 } from './connectedServiceSchemas.js';
import {
  resolveConnectedServiceQuotaMeterLimitIdentity,
  selectConnectedServiceQuotaMetersForLimitSelection,
} from './connectedServiceQuotaLimitSelection.js';

const meters = [
  { meterId: 'standard:primary', providerLimitId: 'standard' },
  { meterId: 'spark:primary', providerLimitId: 'spark' },
  { meterId: 'weekly' },
] as ConnectedServiceQuotaMeterV1[];

describe('selectConnectedServiceQuotaMetersForLimitSelection', () => {
  it('uses the provider identity when present and the legacy meter identity otherwise', () => {
    expect(resolveConnectedServiceQuotaMeterLimitIdentity(meters[0]!)).toBe('standard');
    expect(resolveConnectedServiceQuotaMeterLimitIdentity(meters[2]!)).toBe('weekly');
  });

  it('keeps every meter for the default/all selection', () => {
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters)).toBe(meters);
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters, {
      mode: 'all',
      providerLimitIds: [],
    })).toBe(meters);
  });

  it('uses provider allowance identity and keeps the meterId compatibility fallback', () => {
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters, {
      mode: 'selected',
      providerLimitIds: ['spark', 'weekly'],
    })).toEqual([meters[1], meters[2]]);
  });
});
