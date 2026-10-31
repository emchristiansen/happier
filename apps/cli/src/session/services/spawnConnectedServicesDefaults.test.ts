import { describe, expect, it } from 'vitest';

import {
  resolveSpawnConnectedServicesDefaultDisposition,
  resolveSpawnConnectedServicesDefaults,
} from './spawnConnectedServicesDefaults';

const codexProfileDefaultSettings = {
  connectedServicesDefaultAuthByAgentIdV1: {
    v: 1,
    bindingsByAgentId: {
      codex: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'test-profile-1' },
        },
      },
    },
  },
};

describe('resolveSpawnConnectedServicesDefaults (R4-2 literal resolver)', () => {
  it('resolves the exact Antigravity saved profile from the additive settings carrier', () => {
    const result = resolveSpawnConnectedServicesDefaults({
      agentId: 'agy',
      accountSettings: {
        ...codexProfileDefaultSettings,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            agy: { v: 1, bindingsByServiceId: {
              antigravity: { source: 'connected', selection: 'profile', profileId: 'google-work' },
            } },
          },
        },
      },
    });
    expect(result?.bindingsByServiceId.antigravity).toEqual({
      source: 'connected', selection: 'profile', profileId: 'google-work',
    });
  });

  it('resolves a configured PROFILE default to that exact profile binding', () => {
    // Literal semantics (user-ruled canonical): a stored profile default means that exact account —
    // the resolver never silently upgrades it to an autoSwitch pool at resolution time.
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: codexProfileDefaultSettings,
      agentId: 'codex',
    });
    expect(result?.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'profile',
      profileId: 'test-profile-1',
    });
  });

  it('rejects a malformed additional carrier instead of launching native', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'agy', accountSettings: {
        connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
          agy: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', profileId: '' } } },
        } },
      },
    })).toEqual({ kind: 'unavailable', reason: 'connected_services_default_settings_invalid' });
  });

  it('resolves a configured GROUP default to that group binding', () => {
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            codex: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
              },
            },
          },
        },
      },
      agentId: 'codex',
    });
    expect(result?.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'group',
      groupId: 'happier',
    });
  });

  it('returns null when no connected default is configured for the agent', () => {
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: {},
      agentId: 'codex',
    });
    expect(result).toBeNull();
  });

  it('scopes resolution to the named service only when serviceIds is provided (per-service default)', () => {
    // A bare "openai-codex" token must resolve ONLY openai-codex's stored default — not broaden to every
    // service the agent supports (codex also supports "openai").
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: codexProfileDefaultSettings,
      agentId: 'codex',
      serviceIds: ['openai-codex'],
    });
    expect(result?.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'profile',
      profileId: 'test-profile-1',
    });
    expect(result && Object.keys(result.bindingsByServiceId)).toEqual(['openai-codex']);
  });

  it('returns null when the named service has no stored default (fail-closed to native)', () => {
    // Missing stored default for the requested service → no connected binding → null (the caller then
    // proceeds native), never a guessed account.
    const result = resolveSpawnConnectedServicesDefaults({
      accountSettings: codexProfileDefaultSettings,
      agentId: 'codex',
      serviceIds: ['openai'],
    });
    expect(result).toBeNull();
  });

  it('preserves protocol-tolerant native fallback for a malformed persisted default blob', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: {},
      agentId: 'codex',
    })).toEqual({ kind: 'native' });

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: { v: 999 },
      },
      agentId: 'codex',
    })).toEqual({ kind: 'native' });
  });
});
