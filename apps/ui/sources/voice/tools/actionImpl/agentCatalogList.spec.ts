import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import {
  readDynamicModelProbeCache,
  resetDynamicModelProbeCacheForTests,
  writeDynamicModelProbeCacheSuccess,
  DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';

const machineCapabilitiesInvoke = vi.fn();

const state: any = {
  settings: {
    backendEnabledByTargetKey: {
      'agent:gemini': false,
      'acpBackend:team-review': false,
    },
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    },
  },
};

installVoiceToolActionImplCommonModuleMocks();

const initialStorageState = storage.getState();

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: any[]) => machineCapabilitiesInvoke(...args),
}));

describe('agent catalog voice tools', () => {
  beforeEach(() => {
    machineCapabilitiesInvoke.mockReset();
    state.settings.backendEnabledByTargetKey = {
      'agent:gemini': false,
      'acpBackend:team-review': false,
    };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    storage.setState(initialStorageState, true);
    storage.setState({
      settings: {
        ...settingsDefaults,
        backendEnabledByTargetKey: state.settings.backendEnabledByTargetKey,
        acpCatalogSettingsV1: state.settings.acpCatalogSettingsV1,
      },
    });
    resetDynamicModelProbeCacheForTests();
  });

  it('filters disabled backends by default (includeDisabled=false)', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: false });
    const targetKeys = (res?.items ?? []).map((i: any) => i.targetKey);
    expect(targetKeys).not.toContain('agent:gemini');
    expect(targetKeys).not.toContain('acpBackend:team-review');
  });

  it('includes disabled backends when includeDisabled=true', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const gemini = (res?.items ?? []).find((i: any) => i.targetKey === 'agent:gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
    expect(gemini.uiConnectedService).toEqual({
      serviceId: 'gemini',
      label: 'Google Gemini',
      connectRoute: null,
    });
    const configured = (res?.items ?? []).find((i: any) => i.targetKey === 'acpBackend:team-review');
    expect(configured).toBeTruthy();
    expect(configured.enabled).toBe(false);
    expect(configured.uiConnectedService).toBeNull();
  });

  it('applies limit to backend and model discovery results', async () => {
    const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, limit: 2 });
    expect(backends?.items).toHaveLength(2);

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 2 });
    expect(models?.items).toHaveLength(2);
  });

  it('uses curated static model labels instead of returning raw mode ids', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 3 });

    expect(models?.items?.map((item: any) => item.label)).toEqual([
      'Default',
      ...getAgentStaticModels('claude').slice(0, 2).map((model) => model.name),
    ]);
  });

  it('prefers dynamic model list from machine preflight when machineId is provided', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            {
              id: 'claude-opus',
              name: 'Claude Opus',
              description: 'Opus',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                ],
              }],
            },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res?.items?.map((m: any) => m.modelId)).toEqual(['default', 'claude-opus']);
    expect(res.supportsFreeform).toBe(true);
    expect(res.source).toBe('preflight');

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'm1',
      targetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' }),
      serverId: 'server-a',
      cwd: null,
    });
    expect(cacheKey).toBeTruthy();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    expect(cacheEntry?.kind).toBe('success');
    expect(cacheEntry?.kind === 'success' ? cacheEntry.value.availableModels : []).toEqual([
      { id: 'default', name: 'Default' },
      {
        id: 'claude-opus',
        name: 'Claude Opus',
        description: 'Opus',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        }],
      },
    ]);
  });

  it('caches dynamic model probes per machine/agent so repeated calls do not re-invoke the probe', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'claude-opus', name: 'Claude Opus' },
          ],
          supportsFreeform: false,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
  });

  it('probes configured ACP backend models through backendTargetKey', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'model-review', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const params: Parameters<typeof listAgentModelsForVoiceTool>[0] & Readonly<{ backendTargetKey: string; limit: number }> = {
      backendTargetKey: 'acpBackend:team-review',
      machineId: 'm1',
      limit: 2,
    };
    const res: any = await listAgentModelsForVoiceTool({
      ...params,
    });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.customAcp',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'team-review' },
        },
      },
      { serverId: 'server-a' },
    );
    expect(res).toMatchObject({
      agentId: 'customAcp',
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'model-review', label: 'Review Model' },
      ],
    });
  });

  it('rejects ambiguous customAcp model lookup without backendTargetKey', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const res: any = await listAgentModelsForVoiceTool({
      agentId: 'customAcp',
      machineId: 'm1',
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
  });
  it('keeps provider-owned nonpersistent discovery nonpersistent in the shared cache', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'provider-model', name: 'Provider model' }],
      supportsFreeform: true, source: 'dynamic', cacheable: false,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(result).toMatchObject({ source: 'preflight', items: expect.arrayContaining([{ modelId: 'provider-model', label: 'Provider model' }]) });
    const key = buildDynamicModelProbeCacheKey({ machineId: 'm1', targetKey: 'agent:claude', serverId: 'server-a', cwd: null })!;
    expect(readDynamicModelProbeCache(key)).toMatchObject({ kind: 'success', cacheable: false });
  });

  it('uses a newer daemon last-good observation on failure without renewing its age', async () => {
    const key = buildDynamicModelProbeCacheKey({ machineId: 'm1', targetKey: 'agent:claude', serverId: 'server-a', cwd: null })!;
    const previousAt = Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1000;
    const observedAt = previousAt + 500;
    writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'old', name: 'Old' }], supportsFreeform: true }, previousAt);
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'newer', name: 'Newer' }], supportsFreeform: true,
      source: 'dynamic', cacheable: false, refreshError: true, observedAt,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    expect(await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' })).toMatchObject({
      refreshError: true, items: expect.arrayContaining([{ modelId: 'newer', label: 'Newer' }]),
    });
    expect(readDynamicModelProbeCache(key)).toMatchObject({ updatedAt: observedAt });
  });

  it('distinguishes intentional static policy from a failed discovery fallback', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'policy-model', name: 'Policy model' }], supportsFreeform: true,
      source: 'static', refreshError: false, cacheable: false,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(result).toMatchObject({ items: expect.arrayContaining([{ modelId: 'policy-model', label: 'Policy model' }]) });
    expect(result).not.toHaveProperty('refreshError');
    resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvoke.mockRejectedValue(new Error('offline'));
    expect(await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' })).toMatchObject({ source: 'static', refreshError: true });
  });

});
