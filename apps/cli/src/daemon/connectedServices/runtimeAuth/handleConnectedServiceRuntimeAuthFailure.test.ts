import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';

function groupSwitchState(input: Readonly<{
  activeProfileId: string;
  exhaustedProfileId?: string;
}>): ConnectedServiceAuthGroupSwitchState {
  return {
    serviceId: 'openai-codex',
    groupId: 'main',
    activeProfileId: input.activeProfileId,
    generation: 1,
    runtimeStateRevision: 0,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
    members: [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
    ],
    memberStatesByProfileId: input.exhaustedProfileId
      ? new Map([
          [input.exhaustedProfileId, {
            quotaExhaustedUntilMs: 10_000,
            providerResetsAtMs: 10_000,
          }],
        ])
      : new Map(),
  };
}

describe('handleConnectedServiceRuntimeAuthFailure', () => {
  it('returns a profile action-required state for a single connected profile usage-limit failure', async () => {
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 60_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'profile_action_required',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'main',
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('returns reconnect-required only for a single connected profile credential failure', async () => {
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      classification: {
        kind: 'auth_expired',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: null,
        reason: 'auth_expired',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('returns a provider-state-sharing-required action for native Codex usage-limit recovery', async () => {
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: null,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
        recoveryAction: { kind: 'provider_state_sharing_required' },
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'provider_state_sharing_required',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('uses provider-owned recovery action hints for native usage-limit recovery', async () => {
    const switchAfterClassifiedFailure = vi.fn();
    const classification = {
      kind: 'usage_limit' as const,
      limitCategory: 'usage_limit' as const,
      serviceId: 'provider-owned-service',
      profileId: null,
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
      recoveryAction: { kind: 'provider_state_sharing_required' as const },
    };

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: null,
      classification,
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'provider_state_sharing_required',
        serviceId: 'provider-owned-service',
        profileId: null,
        groupId: null,
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('prefers group switching over provider-owned shared-state recovery hints', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'work',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
        recoveryAction: { kind: 'provider_state_sharing_required' },
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'work',
      retryAfterMs: undefined,
      resetsAtMs: null,
      limitCategory: 'usage_limit',
      quotaScope: undefined,
      providerLimitId: undefined,
      action: undefined,
      planType: null,
      switchesThisTurn: 0,
      sessionSwitchesThisHour: undefined,
    });
  });

  it('passes classified group failures to the group switch coordinator', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailure({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'work',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 60_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    })).resolves.toEqual({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'work',
      retryAfterMs: 60_000,
      resetsAtMs: null,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly',
      action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      planType: null,
      switchesThisTurn: 0,
    });
  });

  it('uses the classified failing profile, not the group-active profile, as the observed current profile', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'primary',
      generation: 1,
    }));

    await handleConnectedServiceRuntimeAuthFailure({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      observedProfileId: 'backup',
    }));
  });

  it('treats the healthy group-active profile as an observed-generation target when the failing session is stale', async () => {
    const commitSwitch = vi.fn(async () => groupSwitchState({ activeProfileId: 'backup' }));
    const applyGeneration = vi.fn(async () => {});
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => groupSwitchState({
        activeProfileId: 'primary',
        exhaustedProfileId: 'backup',
      }),
      commitSwitch,
      applyGeneration,
    });

    await expect(handleConnectedServiceRuntimeAuthFailure({
      sessionId: 'session-1',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
        activeProfileId: 'primary',
        generation: 1,
      },
    });

    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      activeProfileId: 'primary',
      fromProfileId: 'backup',
    }));
  });

  it('keeps excluding the group-active profile as current_active when the failing session is actually on it', async () => {
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => groupSwitchState({
        activeProfileId: 'primary',
        exhaustedProfileId: 'backup',
      }),
      commitSwitch: vi.fn(async () => groupSwitchState({ activeProfileId: 'backup' })),
      applyGeneration: vi.fn(async () => {}),
    });

    await expect(handleConnectedServiceRuntimeAuthFailure({
      sessionId: 'session-1',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'no_eligible_member',
        excluded: expect.arrayContaining([
          { profileId: 'primary', reason: 'current_active' },
          { profileId: 'backup', reason: 'quota_exhausted', retryAtMs: 10_000 },
        ]),
      },
    });
  });

  it('re-applies the current generation when a scheduled usage-limit retry has fresh post-reset quota', async () => {
    const commitSwitch = vi.fn();
    const applyGeneration = vi.fn(async () => {});
    const currentState: ConnectedServiceAuthGroupSwitchState = {
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      generation: 7,
      runtimeStateRevision: 1,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      ],
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 20_000,
            effectiveRemainingPercent: 100,
            windows: [],
          },
        }],
      ]),
    };
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 20_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => currentState,
      commitSwitch,
      applyGeneration,
    });

    await expect(handleConnectedServiceRuntimeAuthFailure({
      sessionId: 'session-1',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: 10_000,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator,
      allowCurrentProfileRetry: true,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
        activeProfileId: 'primary',
        generation: 7,
      },
    });

    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      activeProfileId: 'primary',
      generation: 7,
    }));
  });

  it('does not retry the current member after reset without fresh positive quota proof', async () => {
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 20_000,
      quotaFreshnessMs: 1_000,
      loadState: async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        generation: 7,
        runtimeStateRevision: 0,
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
        members: [{ profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true }],
        memberStatesByProfileId: new Map([['primary', {
          quotaSnapshot: { capturedAtMs: 10_000, effectiveRemainingPercent: 100, windows: [] },
        }]]),
      }),
      commitSwitch: async () => { throw new Error('must not advance the generation'); },
      applyGeneration: async () => { throw new Error('must not re-apply without current proof'); },
    });

    await expect(handleConnectedServiceRuntimeAuthFailure({
      sessionId: 'session-1',
      selection: { kind: 'group', serviceId: 'openai-codex', groupId: 'main', activeProfileId: 'primary' },
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: 10_000,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      switchesThisTurn: 0,
      switchCoordinator,
      allowCurrentProfileRetry: true,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'no_eligible_member', generation: 7 },
    });
  });
});
