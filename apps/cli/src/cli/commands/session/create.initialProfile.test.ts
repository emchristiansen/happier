import { describe, expect, it, vi } from 'vitest';

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({ createCliActionExecutorFromCredentials: vi.fn() }));

import { applySessionCreateInitialProfile } from './create';

describe('applySessionCreateInitialProfile', () => {
  it('adds initialProfileId to the single resolved group binding', () => {
    expect(applySessionCreateInitialProfile({
      path: '/w',
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } } },
    }, 'a')).toEqual({
      path: '/w',
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a' } } },
    });
  });

  it('requires a resolved group binding', () => {
    expect(() => applySessionCreateInitialProfile({
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'a' } } },
    }, 'a')).toThrow('connected_service_initial_profile_requires_group');
  });

  it('leaves input unchanged without the flag', () => {
    const input = { path: '/w' };
    expect(applySessionCreateInitialProfile(input, undefined)).toBe(input);
  });
});
