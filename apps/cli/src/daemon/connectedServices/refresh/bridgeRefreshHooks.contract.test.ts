import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createCodexChatGptBridgeRefreshHooks } from '@/backends/codex/connectedServices/createCodexChatGptBridgeRefreshHooks';
import { createClaudeSubscriptionBridgeRefreshHooks } from '@/backends/claude/connectedServices/createClaudeSubscriptionBridgeRefreshHooks';
import type { ConnectedServiceBridgeRefreshCapabilities } from './bridgeRefreshHooks';
import type { ConnectedServiceCredentialSource } from './refreshTypes';

/**
 * CS-FIX-1 contract test: the provider-specific bridge quirks (Codex ChatGPT response shape;
 * Claude setup-token short-circuit + expiry shaping) live in
 * the provider-owned hook modules, reached ONLY through the coordinator-supplied capabilities. This
 * pins the "a new provider needs only a hook module, no coordinator edit" claim: everything below is
 * exercised without touching the coordinator.
 */
function buildCapabilities(
  overrides: Partial<ConnectedServiceBridgeRefreshCapabilities>,
): ConnectedServiceBridgeRefreshCapabilities {
  return {
    now: () => 1_000,
    readCredentialSource: async () => null,
    isOauthSourceStillValid: () => false,
    resolveSourceExpiresAt: () => null,
    rematerializeTargets: async () => [],
    ...overrides,
  };
}

function oauthSource(accessToken: string): ConnectedServiceCredentialSource {
  return {
    mode: 'plain',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    record: buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 10_000,
      oauth: {
        accessToken,
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    }),
  };
}

describe('createClaudeSubscriptionBridgeRefreshHooks', () => {
  it('short-circuits a setup-token as non-refreshable (provider-owned quirk)', async () => {
    const source: ConnectedServiceCredentialSource = {
      mode: 'plain',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      record: buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: 'primary',
        kind: 'token',
        token: { token: 'setup-token-value', providerAccountId: 'acct', providerEmail: null },
      }),
    };
    const hooks = createClaudeSubscriptionBridgeRefreshHooks({
      capabilities: buildCapabilities({ readCredentialSource: async () => source }),
    });

    const probe = await hooks.probeCurrentToken({ serviceId: 'claude-subscription', profileId: 'primary' });
    expect(probe.kind).toBe('non_refreshable');
    if (probe.kind !== 'non_refreshable') throw new Error('unreachable');
    expect(probe.response.accessToken).toBe('setup-token-value');
    expect(probe.response.anthropicAccountId).toBe('acct');
  });

  it('adopts a still-valid oauth access token through the shared capabilities', async () => {
    const source = oauthSource('valid-access');
    const hooks = createClaudeSubscriptionBridgeRefreshHooks({
      capabilities: buildCapabilities({
        readCredentialSource: async () => source,
        isOauthSourceStillValid: () => true,
        resolveSourceExpiresAt: () => 10_000,
      }),
    });

    const probe = await hooks.probeCurrentToken({ serviceId: 'claude-subscription', profileId: 'primary' });
    expect(probe.kind).toBe('adoptable');
    if (probe.kind !== 'adoptable') throw new Error('unreachable');
    expect(probe.buildResponse()).toEqual({ accessToken: 'valid-access', anthropicAccountId: 'acct', expiresAt: 10_000 });
  });
});

describe('createCodexChatGptBridgeRefreshHooks', () => {
  it('carries the canonical revision when adopting the current Codex token', async () => {
    const source = oauthSource('valid-access');
    const hooks = createCodexChatGptBridgeRefreshHooks({
      chatgptPlanType: 'plus',
      capabilities: buildCapabilities({
        readCredentialSource: async () => source,
        isOauthSourceStillValid: () => true,
      }),
    });

    const probe = await hooks.probeCurrentToken({ serviceId: 'openai-codex', profileId: 'primary' });
    expect(probe.kind).toBe('adoptable');
    if (probe.kind !== 'adoptable') throw new Error('unreachable');
    const selection = { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary', credentialRevision: null } as const;
    expect(probe.buildResponse(selection)).toEqual({
      accessToken: 'valid-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
    });
  });

  it('needs a refresh when the current oauth source is not still valid', async () => {
    const hooks = createCodexChatGptBridgeRefreshHooks({
      chatgptPlanType: null,
      capabilities: buildCapabilities({
        readCredentialSource: async () => oauthSource('stale'),
        isOauthSourceStillValid: () => false,
      }),
    });

    const probe = await hooks.probeCurrentToken({ serviceId: 'openai-codex', profileId: 'primary' });
    expect(probe.kind).toBe('needs_refresh');
  });
});
