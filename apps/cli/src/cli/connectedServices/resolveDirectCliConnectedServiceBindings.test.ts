import { describe, expect, it, vi } from 'vitest';

import type { AccountSettings } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

const { createExecutor } = vi.hoisted(() => ({
  createExecutor: vi.fn(() => {
    throw new Error('an explicit selection must not read the connected-service inventory');
  }),
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: createExecutor,
}));

import { resolveDirectCliConnectedServiceBindings } from './resolveDirectCliConnectedServiceBindings';

const credentials = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
} satisfies Credentials;

/** Ordinary account settings whose Claude default names an unselected connected profile. */
const settingsWithExcludedDefault = {
  connectedServicesDefaultAuthByAgentIdV1: {
    v: 1,
    bindingsByAgentId: {
      claude: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'excluded-default' },
        },
      },
    },
  },
} as unknown as AccountSettings;

describe('resolveDirectCliConnectedServiceBindings', () => {
  it('returns exactly the explicit --auth-json binding, never the configured default or the inventory', async () => {
    const explicit = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'selected-profile' },
      },
    };

    const bindings = await resolveDirectCliConnectedServiceBindings({
      agentId: 'claude',
      credentials,
      accountSettings: settingsWithExcludedDefault,
      authRaw: undefined,
      authJsonRaw: JSON.stringify(explicit),
    });

    expect(bindings).toEqual(explicit);
    expect(JSON.stringify(bindings)).not.toContain('excluded-default');
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it('returns native bindings for explicit --auth native, never the configured default or the inventory', async () => {
    const bindings = await resolveDirectCliConnectedServiceBindings({
      agentId: 'claude',
      credentials,
      accountSettings: settingsWithExcludedDefault,
      authRaw: 'native',
      authJsonRaw: undefined,
    });

    expect(JSON.stringify(bindings)).not.toContain('excluded-default');
    expect(Object.values(bindings?.bindingsByServiceId ?? {})).not.toHaveLength(0);
    for (const binding of Object.values(bindings?.bindingsByServiceId ?? {})) {
      expect(binding).toEqual({ source: 'native' });
    }
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it('keeps an explicit selection usable when the configured default is malformed', async () => {
    const explicit = { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'native' } } };

    await expect(resolveDirectCliConnectedServiceBindings({
      agentId: 'claude',
      credentials,
      accountSettings: { connectedServicesDefaultAuthByAgentIdV1: { v: 99 } } as unknown as AccountSettings,
      authRaw: undefined,
      authJsonRaw: JSON.stringify(explicit),
    })).resolves.toEqual(explicit);
    expect(createExecutor).not.toHaveBeenCalled();
  });
});
