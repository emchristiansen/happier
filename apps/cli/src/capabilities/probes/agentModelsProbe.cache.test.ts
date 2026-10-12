import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProbeTempDir } from './agentModelsProbe.testkit';
import type { Credentials } from '@/persistence';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

const { claudeProbeModelsRawMock, createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  claudeProbeModelsRawMock: vi.fn(async () => [{ id: 'claude-account-model', name: 'Claude Account Model' }]),
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./createConfiguredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    opencode: {
      resolveModelsProbeVariant: ({ connectedServices }: { connectedServices?: { bindingsByServiceId?: Record<string, { selection?: string; groupId?: string; profileId?: string }> } | null }) => {
        const binding = connectedServices?.bindingsByServiceId?.['openai-codex'];
        if (binding?.selection === 'group') return `test:group:${binding.groupId ?? ''}`;
        if (binding?.selection === 'profile') return `test:profile:${binding.profileId ?? ''}`;
        return 'test:native';
      },
      getPreflightSessionControlsProbeAdapter: async () => ({
        failureCacheStrategy: 'cooldown',
        probeModelsRaw: async (params: { connectedServices?: { bindingsByServiceId?: Record<string, { selection?: string; groupId?: string; profileId?: string }> } | null }) => {
          const binding = params.connectedServices?.bindingsByServiceId?.['openai-codex'];
          if (binding?.selection === 'group') return [{ id: 'group-model', name: 'Group Model' }];
          if (binding?.selection === 'profile') return [{ id: 'profile-model', name: 'Profile Model' }];
          return null;
        },
      }),
    },
    claude: {
      getPreflightSessionControlsProbeAdapter: async () => ({
        modelProbeCachePolicy: 'provider-owned',
        failureCacheStrategy: 'cooldown',
        probeModelsRaw: claudeProbeModelsRawMock,
      }),
    },
  },
}));

describe('probeAgentModelsBestEffort (cache)', () => {
  beforeEach(resetAgentModelsProbeCacheForTests);
  it('partitions cached probe results by connected-services identity', async () => {

    const fixture = await createProbeTempDir('happier-cli-model-probe-cs-cache');
    try {
      resetAgentModelsProbeCacheForTests();

      const groupConnectedServices = {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'leeroy',
          },
        },
      } as const;
      const profileConnectedServices = {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'leeroy',
          },
        },
      } as const;

      const group = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: fixture.dir,
        timeoutMs: 2_000,
        connectedServices: groupConnectedServices,
      });
      const profile = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: fixture.dir,
        timeoutMs: 2_000,
        connectedServices: profileConnectedServices,
      });

      expect(group.availableModels.map((model) => model.id)).toEqual(['default', 'group-model']);
      expect(profile.availableModels.map((model) => model.id)).toEqual(['default', 'profile-model']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves provider-owned results transient and forwards auth context without generic caching', async () => {
    claudeProbeModelsRawMock.mockClear();

    const fixture = await createProbeTempDir('happier-cli-model-probe-provider-cache');
    try {
      resetAgentModelsProbeCacheForTests();

      const credentials: Credentials = {
        token: 'account-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      };
      const accountSettings = { connectedServicesSettingsV1: { version: 1 } };
      const connectedServices = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'connected-profile',
          },
        },
      } as const;
      const params = {
        agentId: 'claude' as const,
        cwd: fixture.dir,
        timeoutMs: 2_000,
        profileId: 'session-profile',
        credentials,
        accountSettings,
        connectedServices,
      };

      const [first, concurrent] = await Promise.all([
        probeAgentModelsBestEffort(params),
        probeAgentModelsBestEffort(params),
      ]);
      const later = await probeAgentModelsBestEffort(params);

      expect(first).toMatchObject({ source: 'dynamic', cacheable: false });
      expect(concurrent.availableModels).toEqual(first.availableModels);
      expect(later).toMatchObject({ source: 'dynamic', cacheable: false });
      expect(claudeProbeModelsRawMock).toHaveBeenCalledTimes(3);
      expect(claudeProbeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'session-profile',
        credentials,
        accountSettings,
        connectedServices,
      }));
    } finally {
      await fixture.cleanup();
    }
  });
});
