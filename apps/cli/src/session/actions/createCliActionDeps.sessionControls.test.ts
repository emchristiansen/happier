import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import {
  ReviewStartInputSchema,
  SessionUsageLimitRecoveryOperationResultV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({ data: { didWrite: true } })),
  axiosGet: vi.fn(async (): Promise<unknown> => ({ status: 200, data: { id: 'acct_1', connectedServicesV2: [] } })),
  bootstrapAccountSettingsContext: vi.fn(async (): Promise<unknown> => ({ settings: {}, settingsVersion: 1, loadedAtMs: 1 })),
  callSessionRpc: vi.fn(async () => ({ ok: true })),
  callMachineRpc: vi.fn(async (_params: unknown): Promise<unknown> => ({ type: 'success', sessionId: 'sess_1' })),
  createSpawnedSession: vi.fn(async () => ({
    sessionId: 'spawned_1',
    created: true,
    session: { id: 'spawned_1' },
  })),
  detectProviderMcpServers: vi.fn(async (): Promise<unknown> => ({ servers: [], warnings: [] })),
  getSessionCatalogControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  getSessionGoalControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  getSessionUsageLimitRecoveryControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  notifyDaemonConnectedServiceRuntimeAuthFailure: vi.fn(async (_body: unknown) => ({
    ok: true,
    result: {
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    },
  })),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ machineId: 'machine-local' }),
  })),
  getSessionEvents: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  getSessionTranscript: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  listSessions: vi.fn(async (): Promise<unknown> => ({ sessions: [], nextCursor: null })),
  listDaemonStatusesForAllKnownServers: vi.fn(async (): Promise<unknown> => []),
  readSettings: vi.fn(async () => ({ machineId: 'machine-local' })),
  resolveCliFeatureDecisionForServer: vi.fn(async (_params?: unknown): Promise<unknown> => ({ decision: { state: 'enabled' } })),
  resolveSessionTransportContext: vi.fn(async (): Promise<unknown> => ({
    ok: true as const,
    sessionId: 'sess_1',
    rawSession: { active: true },
    ctx: {
      encryptionKey: new Uint8Array(32).fill(3),
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  })),
  sendSessionMessage: vi.fn(async (_params: Parameters<typeof import('@/session/services/sendSessionMessage').sendSessionMessage>[0]): Promise<unknown> => ({ ok: true })),
}));

vi.mock('axios', () => ({
  default: { get: mocks.axiosGet, post: mocks.axiosPost },
  get: mocks.axiosGet,
}));
vi.mock('@/backends/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backends/catalog')>()),
  getSessionCatalogControlAdapter: mocks.getSessionCatalogControlAdapter,
  getSessionGoalControlAdapter: mocks.getSessionGoalControlAdapter,
  getSessionUsageLimitRecoveryControlAdapter: mocks.getSessionUsageLimitRecoveryControlAdapter,
}));
vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: mocks.resolveCliFeatureDecisionForServer,
}));
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));
vi.mock('@/mcp/providerDetection/detectProviderMcpServers', () => ({
  detectProviderMcpServers: mocks.detectProviderMcpServers,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings: mocks.readSettings,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: mocks.callSessionRpc }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: mocks.callMachineRpc }));
vi.mock('@/session/services/createSpawnedSession', () => ({ createSpawnedSession: mocks.createSpawnedSession }));
vi.mock('@/session/services/getSessionEvents', () => ({ getSessionEvents: mocks.getSessionEvents }));
vi.mock('@/session/services/getSessionTranscript', () => ({ getSessionTranscript: mocks.getSessionTranscript }));
vi.mock('@/session/services/listSessions', () => ({ listSessions: mocks.listSessions }));
vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: mocks.listDaemonStatusesForAllKnownServers,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/services/sendSessionMessage', () => ({ sendSessionMessage: mocks.sendSessionMessage }));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mocks.notifyDaemonConnectedServiceRuntimeAuthFailure,
}));

import { createCliActionDeps, createCliActionInventoryDeps } from './createCliActionDeps';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('createCliActionDeps session controls', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.axiosPost.mockReset();
    mocks.axiosPost.mockResolvedValue({ data: { didWrite: true } });
    mocks.axiosGet.mockReset();
    mocks.axiosGet.mockResolvedValue({ status: 200, data: { id: 'acct_1', connectedServicesV2: [] } });
    mocks.bootstrapAccountSettingsContext.mockReset();
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({ settings: {}, settingsVersion: 1, loadedAtMs: 1 });
    mocks.callSessionRpc.mockReset();
    mocks.callSessionRpc.mockResolvedValue({ ok: true });
    mocks.callMachineRpc.mockReset();
    mocks.callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'sess_1' });
    mocks.createSpawnedSession.mockReset();
    mocks.createSpawnedSession.mockResolvedValue({
      sessionId: 'spawned_1',
      created: true,
      session: { id: 'spawned_1' },
    });
    mocks.detectProviderMcpServers.mockReset();
    mocks.detectProviderMcpServers.mockResolvedValue({ servers: [], warnings: [] });
    mocks.getSessionCatalogControlAdapter.mockReset();
    mocks.getSessionCatalogControlAdapter.mockResolvedValue(null);
    mocks.getSessionGoalControlAdapter.mockReset();
    mocks.getSessionGoalControlAdapter.mockResolvedValue(null);
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockReset();
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValue(null);
    mocks.notifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mocks.notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    });
    mocks.updateSessionMetadataWithRetry.mockReset();
    mocks.updateSessionMetadataWithRetry.mockImplementation(async (params: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: params.updater({ machineId: 'machine-local' }),
    }));
    mocks.getSessionEvents.mockClear();
    mocks.getSessionTranscript.mockClear();
    mocks.listSessions.mockClear();
    mocks.listDaemonStatusesForAllKnownServers.mockReset();
    mocks.listDaemonStatusesForAllKnownServers.mockResolvedValue([]);
    mocks.readSettings.mockReset();
    mocks.readSettings.mockResolvedValue({ machineId: 'machine-local' });
    mocks.resolveCliFeatureDecisionForServer.mockReset();
    mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({ decision: { state: 'enabled' } });
    mocks.resolveSessionTransportContext.mockReset();
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: { active: true },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    mocks.sendSessionMessage.mockClear();
  });

  it('lists models from provider probes instead of stale current-session metadata', async () => {
    // This case exercises the cold fallback; the catalog's discovered-membership cases
    // exercise dynamic discovery separately through their HTTP boundary fixtures.
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo',
        metadata: {
          happierSessionModelsStateV1: {
            provider: 'claude',
            availableModels: [{ id: 'stale-current-session-only', name: 'Stale metadata model' }],
          },
        },
      },
    });

    const result = await deps.agentsModelsList({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };

    expect(result.source).toBe('static');
    expect(result.items?.some((item) => item.id === 'stale-current-session-only')).toBe(false);
    expect(result.items?.some((item) => item.id === 'claude-opus-4-8')).toBe(true);
  });

  it('lists session mode identifiers without transforming provider-owned bytes', async () => {
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: {
        metadata: {
          sessionModesV1: {
            v: 1,
            provider: 'cursor',
            updatedAt: 1,
            currentModeId: ' plan ',
            availableModes: [{ id: ' plan ', name: 'Plan' }],
          },
        },
      },
    });

    const result = await deps.sessionModesList?.({ sessionId: 'sess_1' });
    expect(result).toEqual({
      sessionId: 'sess_1',
      items: [{ id: ' plan ', label: 'Plan' }],
    });
  });

  it('lazily resolves current-session transport when inventory metadata was not seeded', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        metadata: {
          sessionModesV1: {
            v: 1,
            provider: 'cursor',
            updatedAt: 1,
            availableModes: [{ id: 'agent', name: 'Agent' }],
          },
        },
      },
      ctx: { encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'legacy' as const },
      mode: 'plain' as const,
    });
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: null,
    });

    await expect(deps.sessionModesList?.({ sessionId: 'sess_1' })).resolves.toEqual({
      sessionId: 'sess_1',
      items: [{ id: 'agent', label: 'Agent' }],
    });
    expect(mocks.resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials: expect.any(Object),
      idOrPrefix: 'sess_1',
    });
  });

  it('lists agent session modes and config options from the shared option registry', async () => {
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { path: '/repo', metadata: {} },
    });

    const modes = await deps.agentsSessionModesList?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };
    const configOptions = await deps.agentsConfigOptionsList?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };

    expect(modes.source).toBeTruthy();
    expect(Array.isArray(modes.items)).toBe(true);
    expect(configOptions.source).toBeTruthy();
    expect(Array.isArray(configOptions.items)).toBe(true);
    expect(JSON.stringify(configOptions)).not.toMatch(/token|secret|password/i);
  });

  it('lists spawn target paths, account machines, and configured servers through their canonical owners', async () => {
    mocks.axiosGet.mockResolvedValueOnce({ status: 200, data: [
      { id: 'machine-cloud', active: true },
      { id: 'machine-remote', active: false },
    ] });
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        { id: 'sess-a', path: '/repo/a', host: 'host-a', activeAt: 30 },
        { id: 'sess-a-older', path: '/repo/a', host: 'host-a', activeAt: 20 },
        { id: 'sess-b', path: '/repo/b', host: 'host-b', activeAt: 10 },
        { id: 'sess-missing-path', host: 'host-c', activeAt: 5 },
      ],
      nextCursor: null,
    });
    mocks.listDaemonStatusesForAllKnownServers.mockResolvedValue([
      {
        serverId: 'cloud',
        name: 'Cloud',
        serverUrl: 'https://api.example.test',
        comparableKey: 'api.example.test',
        daemonStatePath: '/state/cloud.json',
        auth: {
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine-cloud',
          accountId: 'acct-1',
        },
        drift: { activeComparableKey: 'api.example.test', matchesActiveRelay: true },
        service: { installed: true, running: true },
        daemon: { pid: 123, httpPort: 456, running: true, staleStateFile: false },
      },
      {
        serverId: 'local',
        name: 'Local',
        serverUrl: 'http://127.0.0.1:3000',
        comparableKey: '127.0.0.1:3000',
        daemonStatePath: '/state/local.json',
        auth: {
          authenticated: false,
          needsAuth: true,
          machineRegistered: false,
          machineId: null,
          accountId: null,
        },
        drift: { activeComparableKey: 'api.example.test', matchesActiveRelay: false },
        service: { installed: false, running: false },
        daemon: { pid: null, httpPort: null, running: false, staleStateFile: false },
      },
    ]);

    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const paths = await deps.pathsListRecent({ limit: 2 }) as { items: readonly unknown[] };
    const machines = await deps.machinesList({ limit: 10 }) as { items: readonly unknown[] };
    const servers = await deps.serversList({ limit: 10 }) as { items: readonly unknown[] };

    expect(paths.items).toEqual([
      {
        value: '/repo/a',
        label: '/repo/a',
        path: '/repo/a',
        host: 'host-a',
        sessionId: 'sess-a',
        activeAt: 30,
      },
      {
        value: '/repo/b',
        label: '/repo/b',
        path: '/repo/b',
        host: 'host-b',
        sessionId: 'sess-b',
        activeAt: 10,
      },
    ]);
    expect(machines.items).toEqual([
      {
        value: 'machine-cloud',
        label: 'machine-cloud',
        machineId: 'machine-cloud',
        serverId: configuration.activeServerId,
        serverName: configuration.serverUrl,
        authenticated: true,
        machineRegistered: true,
        daemonRunning: true,
      },
      {
        value: 'machine-remote',
        label: 'machine-remote',
        machineId: 'machine-remote',
        serverId: configuration.activeServerId,
        serverName: configuration.serverUrl,
        authenticated: true,
        machineRegistered: true,
        daemonRunning: false,
      },
    ]);
    expect(servers.items).toEqual([
      {
        value: 'cloud',
        label: 'Cloud',
        serverId: 'cloud',
        serverUrl: 'https://api.example.test',
        authenticated: true,
        needsAuth: false,
        machineId: 'machine-cloud',
        daemonRunning: true,
      },
      {
        value: 'local',
        label: 'Local',
        serverId: 'local',
        serverUrl: 'http://127.0.0.1:3000',
        authenticated: false,
        needsAuth: true,
        machineId: null,
        daemonRunning: false,
      },
    ]);
    expect(JSON.stringify({ paths, machines, servers })).not.toContain('acct-1');
  });

  it('lists spawn profiles from account settings without profile env values or secret binding ids', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        profiles: [
          {
            id: 'custom-openai',
            name: 'Custom OpenAI',
            description: 'Custom profile',
            environmentVariables: [{ name: 'OPENAI_API_KEY', value: 'SECRET_VALUE', isSecret: true }],
            envVarRequirements: [
              { name: 'OPENAI_API_KEY', kind: 'secret', required: true },
              { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
            ],
            compatibilityByTargetKey: { 'agent:codex': true },
            defaultEnabled: true,
            isBuiltIn: false,
          },
        ],
        secretBindingsByProfileId: {
          'custom-openai': { OPENAI_API_KEY: 'secret_binding_id' },
        },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items?.find((item) => item.id === 'custom-openai')).toMatchObject({
      value: 'custom-openai',
      label: 'Custom OpenAI',
      id: 'custom-openai',
      name: 'Custom OpenAI',
      isBuiltIn: false,
      supportedAgentIds: expect.arrayContaining(['codex']),
      requiredSecretEnvVarNames: ['OPENAI_API_KEY'],
      requiredConfigEnvVarNames: ['GOOGLE_CLOUD_PROJECT'],
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(result)).not.toContain('secret_binding_id');
  });

  it('reads current account settings for spawn profile inventory without recreating deps', async () => {
    mocks.bootstrapAccountSettingsContext
      .mockResolvedValueOnce({
        settings: {
          profiles: [
            {
              id: 'old-profile',
              name: 'Old profile',
              compatibilityByTargetKey: { 'agent:codex': true },
              defaultEnabled: true,
              isBuiltIn: false,
            },
          ],
        },
        settingsVersion: 1,
        loadedAtMs: 1,
      })
      .mockResolvedValueOnce({
        settings: {
          profiles: [
            {
              id: 'new-profile',
              name: 'New profile',
              compatibilityByTargetKey: { 'agent:codex': true },
              defaultEnabled: true,
              isBuiltIn: false,
            },
          ],
        },
        settingsVersion: 2,
        loadedAtMs: 2,
      });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    });
    const result = await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledTimes(2);
    expect(result?.items?.map((item) => item.id)).toContain('new-profile');
    expect(result?.items?.map((item) => item.id)).not.toContain('old-profile');
  });

  it('lists spawn connected-service options from account profile projection without credential material', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        connectedServicesProfileLabelByKey: { 'openai-codex/work': 'Work OpenAI' },
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [
              {
                profileId: 'work',
                status: 'connected',
                kind: 'oauth',
                providerEmail: 'dev@example.com',
                providerAccountId: 'provider-account-id',
              },
              {
                profileId: 'token-profile',
                status: 'connected',
                kind: 'token',
                providerEmail: 'token@example.com',
              },
            ],
            groups: [
              {
                groupId: 'group_1',
                displayName: 'Work group',
                activeProfileId: 'work',
                memberProfileIds: ['work'],
                generation: 3,
              },
            ],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items).toEqual([
      expect.objectContaining({
        value: 'openai-codex',
        label: 'openai-codex',
        serviceId: 'openai-codex',
        profiles: [
          {
            profileId: 'work',
            status: 'connected',
            kind: 'oauth',
            providerEmail: 'dev@example.com',
            label: 'Work OpenAI',
          },
          {
            profileId: 'token-profile',
            status: 'unsupported_kind',
            kind: 'token',
            providerEmail: 'token@example.com',
            label: null,
          },
        ],
        accountGroups: [
          {
            groupId: 'group_1',
            label: 'Work group',
            activeProfileId: 'work',
            memberProfileIds: ['work'],
            generation: 3,
            enabledMemberCount: 1,
            autoSwitch: false,
            status: 'ready',
          },
        ],
        defaultProfileId: 'work',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('provider-account-id');
    expect(JSON.stringify(result)).not.toMatch(/token_value|secret|ciphertext/i);
  });

  it('fails connected-service discovery closed when connected-services feature gates are disabled', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockImplementation(async (params?: unknown) => ({
      decision: {
        state: (params as { featureId?: unknown } | undefined)?.featureId === 'connectedServices'
          ? 'disabled'
          : 'enabled',
      },
    }));
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            groups: [{ groupId: 'group_1', displayName: 'Work group', activeProfileId: 'work', memberProfileIds: ['work'] }],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    })).resolves.toEqual({ items: [] });
    expect(mocks.axiosGet).not.toHaveBeenCalled();
  });

  it('omits connected-service account groups when account-group feature gate is disabled', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockImplementation(async (params?: unknown) => ({
      decision: {
        state: (params as { featureId?: unknown } | undefined)?.featureId === 'connectedServices.accountGroups'
          ? 'disabled'
          : 'enabled',
      },
    }));
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            groups: [{ groupId: 'group_1', displayName: 'Work group', activeProfileId: 'work', memberProfileIds: ['work'] }],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items?.[0]).toMatchObject({
      serviceId: 'openai-codex',
      accountGroups: [],
    });
  });

  it('previews spawn MCP servers through the daemon preview owner without secret refs', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        mcpServersSettingsV1: {
          v: 1,
          strictMode: false,
          servers: [
            {
              id: 'srv_linear',
              name: 'linear',
              title: 'Linear',
              transport: 'stdio',
              stdio: { command: 'linear-mcp', args: [] },
              env: { LINEAR_API_KEY: { t: 'savedSecret', secretId: 'saved_secret_linear' } },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          bindings: [
            {
              id: 'bind_linear',
              serverId: 'srv_linear',
              enabled: true,
              target: { t: 'allMachines' },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    mocks.detectProviderMcpServers.mockResolvedValue({
      servers: [
        {
          provider: 'claude',
          name: 'playwright',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['@playwright/mcp'] },
          envKeys: ['PLAYWRIGHT_TOKEN'],
          enabled: true,
          source: { kind: 'project', path: '/repo/.claude/settings.local.json' },
        },
      ],
      warnings: [],
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo',
        machineId: 'machine-local',
        metadata: { path: '/repo', machineId: 'machine-local' },
      },
    });

    const result = await deps.sessionsSpawnMcpServersPreview?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      machineId: 'machine-local',
      path: '/repo',
      limit: 200,
    }) as { ok?: boolean; managed?: readonly Record<string, unknown>[]; detected?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.ok).toBe(true);
    expect(result?.managed?.[0]).toMatchObject({
      key: 'managed:srv_linear',
      serverId: 'srv_linear',
      name: 'linear',
      title: 'Linear',
      authMode: 'savedSecret',
      selected: true,
      sourceKind: 'managed',
    });
    expect(result?.detected?.[0]).toMatchObject({
      key: 'detected:claude:playwright',
      name: 'playwright',
      authMode: 'unknown',
      envKeyCount: 1,
      sourceKind: 'detected',
      scopeKind: 'providerProject',
    });
    expect(mocks.detectProviderMcpServers).toHaveBeenCalledWith({
      directory: '/repo',
      providers: undefined,
      env: process.env,
    });
    expect(JSON.stringify(result)).not.toContain('saved_secret_linear');
    expect(JSON.stringify(result)).not.toContain('LINEAR_API_KEY');
    expect(JSON.stringify(result)).not.toContain('PLAYWRIGHT_TOKEN');
  });

  it('rejects invalid message permission overrides before sending to the service', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await deps.sessionSendMessage({
      sessionId: 'sess_2',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      permissionModeOverride: 'not-a-mode',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it.each(['resume_failed', 'pre_admission_timeout'] as const)('keeps custody in action errors only after admission: %s', async (outcome) => {
    const { sendSessionMessage } = await vi.importActual<typeof import('@/session/services/sendSessionMessage')>('@/session/services/sendSessionMessage');
    mocks.sendSessionMessage.mockImplementationOnce(sendSessionMessage);
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess_1', mode: 'plain',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      rawSession: {
        id: 'sess_1', active: false, encryptionMode: 'plain', path: '/repo', machineId: 'machine-session',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'native-thread', path: '/repo', machineId: 'machine-session' }),
      },
    });
    mocks.callMachineRpc.mockResolvedValue({ type: 'error', errorMessage: 'Resume rejected' });
    if (outcome === 'pre_admission_timeout') mocks.axiosPost.mockRejectedValueOnce(new Error('Pending acknowledgement timed out'));
    const deps = createCliActionDeps({ token: 'token', credentials: createCredentials(), sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' }, mode: 'plain', rawSession: { metadata: {} } });
    const result = await deps.sessionSendMessage({ sessionId: 'sess_1', message: 'hello', requestedAction: { v: 1, kind: 'steer_if_active' } });
    if (outcome === 'pre_admission_timeout') {
      expect(result).toEqual({ ok: false, errorCode: 'timeout', error: 'timeout', message: 'Pending acknowledgement timed out' });
      expect(mocks.callMachineRpc).not.toHaveBeenCalled();
    } else {
      const body = mocks.axiosPost.mock.calls[0]?.[1] as { localId: string };
      expect(result).toEqual({ ok: false, errorCode: 'resume_failed', error: 'resume_failed', message: 'Resume rejected',
        details: { pendingCustody: 'confirmed', sessionId: 'sess_1', localId: body.localId } });
    }
  });

  it('forwards the session-agent permission ceiling without manufacturing a target mode override', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    await deps.sessionSendMessage({
      sessionId: 'sess_2',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      callerSurface: 'session_agent',
      callerPermissionMode: 'safe-yolo',
    });

    expect(mocks.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      permissionModeCeiling: 'safe-yolo',
    }));
    expect(mocks.sendSessionMessage).toHaveBeenCalledWith(expect.not.objectContaining({
      permissionModeOverride: expect.anything(),
    }));
  });

  it('preserves exact nonblank opaque model override bytes through the CLI service adapter', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionSendMessage({
      sessionId: 'sess_1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      modelOverride: ' model-a\t',
    });

    expect(mocks.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: ' model-a\t',
    }));
  });

  it('wires transcript and events actions to the canonical services', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionTranscriptGet?.({
      sessionId: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    await deps.sessionEventsGet?.({
      sessionId: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });

    expect(mocks.getSessionTranscript).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    expect(mocks.getSessionEvents).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });
  });

  it('forwards session list preview and row shape options to the list service', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionList({
      limit: 10,
      cursor: 'cursor-1',
      includeLastMessagePreview: true,
      includeRows: true,
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
    });

    expect(mocks.listSessions).toHaveBeenCalledWith({
      credentials,
      activeOnly: true,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      includeLastMessagePreview: true,
      includeRows: true,
      limit: 10,
      cursor: 'cursor-1',
    });
  });

  it('calls native session goal RPC instead of sending goal text', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({ sessionId: 'sess_1', objective: 'Ship native goals' })).resolves.toEqual({
      ok: true,
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'plain',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
      request: { objective: 'Ship native goals' },
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('calls live terminal composer clear RPC for session terminal composer clear actions', async () => {
    mocks.callSessionRpc.mockResolvedValueOnce({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    } as never);
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionTerminalComposerClear?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    })).resolves.toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'plain',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR}`,
      request: {
        sessionId: 'sess_1',
        expectedStateAtMs: 1_700_000_000_000,
      },
    }));
  });

  it('delegates inactive local goal mutations to the provider goal control adapter', async () => {
    const providerSetGoal = vi.fn(async (_params: unknown) => ({ ok: true, workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 } }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      objective: 'Ship native goals',
      status: 'paused',
      tokenBudget: null,
    })).resolves.toEqual({
      ok: true,
      workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 },
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionGoalControlAdapter).toHaveBeenCalledWith('codex');
    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      request: {
        objective: 'Ship native goals',
        status: 'paused',
        tokenBudget: null,
      },
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
      currentMachineId: 'machine-local',
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('omits objective from status-only inactive goal mutations', async () => {
    const providerSetGoal = vi.fn(async (_params: { request: Record<string, unknown> }) => ({ ok: true }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      status: 'paused',
    })).resolves.toEqual({ ok: true });

    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      request: { status: 'paused' },
    }));
    const request = providerSetGoal.mock.calls[0]?.[0].request;
    expect(Object.prototype.hasOwnProperty.call(request, 'objective')).toBe(false);
  });

  it('calls native catalog RPCs for vendor plugins and skills', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionVendorPluginCatalogList?.({ sessionId: 'sess_1' });
    await deps.sessionSkillCatalogList?.({ sessionId: 'sess_1' });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('delegates inactive local catalog requests to the provider catalog control adapter', async () => {
    const listVendorPlugins = vi.fn(async (_params: unknown) => ({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    }));
    const listSkills = vi.fn(async (_params: unknown) => ({
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' }],
    }));
    mocks.getSessionCatalogControlAdapter.mockResolvedValue({
      listVendorPlugins,
      listSkills,
    });
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionVendorPluginCatalogList?.({ sessionId: 'sess_inactive', cwd: '/repo' })).resolves.toEqual({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    await expect(deps.sessionSkillCatalogList?.({ sessionId: 'sess_inactive', cwd: '/repo' })).resolves.toEqual({
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' }],
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionCatalogControlAdapter).toHaveBeenCalledWith('codex');
    expect(listVendorPlugins).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      cwd: '/repo',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      cwd: '/repo',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
  });

  it('calls native inline review RPCs without sending user prompts', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Check correctness.',
      input,
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE}`,
      request: input,
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects native inline review permission above the caller permission before RPC dispatch', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
      permissionMode: 'workspace_write',
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Check correctness.',
      input,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
      details: {
        requestedMode: 'safe-yolo',
        requestedOrdinal: 2,
        callerMode: 'default',
        callerOrdinal: 1,
      },
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('uses the forwarded session-agent caller permission mode for spawn non-escalation', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      callerSurface: 'session_agent',
      callerPermissionMode: 'bypassPermissions',
      permissionMode: 'bypassPermissions',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'spawned_1',
    });

    expect(mocks.createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      permissionMode: 'bypassPermissions',
    }));
  });

  it('calls native usage-limit recovery RPCs', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      remember: true,
    });
    await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    });
    await deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1' });

    // No explicit per-operation resume prompt mode was requested, so none may be
    // forwarded: downstream owners must resolve the precedence tiers themselves
    // (stored intent > account setting > group policy > provider config > default).
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: 'usage-limit:sess_1:reset',
        remember: true,
      },
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL}`,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: null,
      },
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: { sessionId: 'sess_1' },
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('forwards an explicit custom resume prompt mode unchanged for usage-limit controls', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      resumePromptMode: 'custom',
    });
    await deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1', resumePromptMode: 'custom' });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`,
      request: expect.objectContaining({ resumePromptMode: 'custom' }),
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: expect.objectContaining({ resumePromptMode: 'custom' }),
    }));
  });

  it('routes active temporary-throttle retry-now through the daemon scheduler callback', async () => {
    const retryTemporaryThrottleNow = vi.fn(async () => ({ status: 'resumed' }));
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        metadata: {
          machineId: 'machine-local',
        },
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          provider: 'codex',
          providerTurnId: 'turn-throttle',
          occurredAt: 1_700_000_000_000,
          sanitizedPreview: 'Provider is temporarily limiting requests',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 30_000,
            recoverability: 'retry',
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      retryTemporaryThrottleNow,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1' })).resolves.toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });

    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionUsageLimitRecoveryControlAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['live control succeeds', {
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale',
    }, false],
    ['app-server control is unavailable', {
      ok: false,
      errorCode: 'codex_app_server_control_unavailable',
      error: 'codex_app_server_control_unavailable',
    }, true],
    ['the stale Session RPC is unreachable', {
      ok: false,
      errorCode: 'session_rpc_failed',
      error: 'session_rpc_failed',
    }, true],
  ])('handles a stale active Codex session when %s', async (_scenario, liveResult, shouldSpawn) => {
    mocks.callSessionRpc.mockResolvedValueOnce(liveResult);
    mocks.callMachineRpc.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_stale' });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_stale',
      rawSession: {
        id: 'sess_stale',
        active: true,
        latestTurnStatus: 'failed',
        path: '/repo',
        machineId: 'machine-local',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-usage-limited',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
        metadata: {
          machineId: 'machine-local',
          path: '/repo',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'codex-thread-persisted',
            },
          },
          codexSessionId: 'codex-thread-persisted',
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_current',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_stale', provider: 'codex' })).resolves.toEqual(shouldSpawn ? {
      ok: false, status: 'unsupported', sessionId: 'sess_stale',
      errorCode: 'session_usage_limit_recovery_control_provider_unsupported',
    } : { ok: true, status: 'ready', sessionId: 'sess_stale' });
    expect(mocks.callSessionRpc).toHaveBeenCalledTimes(1);
    // Attaching a process cannot claim resumption without a continuation handoff.
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();

  });

  it('routes inactive local usage-limit controls without re-entering live session RPC', async () => {
    const checkNow = vi.fn(async (_params: unknown) => ({ ok: true, status: 'ready' }));
    // The adapter is also consulted for the provider-config resume-prompt tier,
    // so it must resolve consistently across the whole test.
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValue({
      checkNow,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
    })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_inactive',
    });
    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });
    mocks.callMachineRpc.mockResolvedValue({ ok: false, errorCode: 'session_usage_limit_recovery_control_inactive' });
    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_inactive' })).resolves.toEqual({
      ok: false, status: 'inactive', sessionId: 'sess_inactive',
      errorCode: 'session_usage_limit_recovery_control_inactive',
    });
    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionUsageLimitRecoveryControlAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(2);
    // The owner-tagged cancelled attempt cannot be reconstructed from the old issue.
    expect(checkNow).not.toHaveBeenCalled();

  });

  it('passes inactive ready usage-limit recovery through the daemon resume callback', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async (_params: unknown) => ({ ok: true, status: 'ready' }));
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValueOnce({ checkNow });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      resumeInactiveSessionWhenUsageLimitReady: resumeInactiveSessionWhenReady,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_inactive' })).resolves.toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_inactive',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
  });

  it('routes usage-limit switch-account controls through daemon runtime-auth recovery instead of live check-now', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_group',
      rawSession: {
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            action: { kind: 'settings' },
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'codex' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_group',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_group',
      provider: 'codex',
      resumePromptMode: 'custom',
    })).resolves.toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'sess_group',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'sess_group',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        quotaScope: 'account',
        action: null,
        limitCategory: 'usage_limit',
      }),
      resumePromptMode: 'custom',
    });
  });

  it('uses the injected runtime-auth notifier for daemon machine usage-limit switch-account controls', async () => {
    const notifyConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    }));
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_group',
      rawSession: {
        active: false,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'codex' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_group',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      notifyConnectedServiceRuntimeAuthFailure,
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_group',
      provider: 'codex',
    })).resolves.toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'sess_group',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(notifyConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'sess_group',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
      }),
    });
    expect(mocks.notifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('schedules an inactive usage-limit recovery check when wait-resume is armed', async () => {
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'claude',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: 1_700_000_060_000,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      scheduleInactiveSessionUsageLimitRecoveryCheck,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      scheduleInactiveSessionUsageLimitRecoveryCheck: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
    })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_inactive',
    });

    expect(scheduleInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      recovery: expect.objectContaining({
        status: 'waiting',
        nextCheckAtMs: 1_700_000_060_000,
      }),
      runCheckNow: expect.any(Function),
    }));
  });

  it('clears an inactive usage-limit recovery check when wait-resume is cancelled', async () => {
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
          },
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      cancelInactiveSessionUsageLimitRecoveryCheck,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      cancelInactiveSessionUsageLimitRecoveryCheck: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });

    expect(cancelInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  // QAE-1: the routed daemon-side cancel must clear the daemon runtime-auth
  // recovery store too, not only the inactive usage-limit check — an armed
  // runtime-auth waiting intent resumes the session involuntarily at reset.
  it('cancels the daemon runtime-auth recovery intent when wait-resume is cancelled', async () => {
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
          },
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      cancelConnectedServiceRuntimeAuthRecovery,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      cancelConnectedServiceRuntimeAuthRecovery: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });

    expect(cancelConnectedServiceRuntimeAuthRecovery).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('fails usage-limit recovery actions closed when the feature is disabled for the target server', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({ decision: { state: 'disabled' } });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      remember: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_1',
      provider: 'codex',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('returns schema-valid usage-limit recovery errors when credentials are unavailable', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_1',
      provider: 'codex',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit permission response for a request already completed in session state', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {},
          completedRequests: {
            perm_done_1: { kind: 'permission', tool: 'Write', status: 'approved', createdAt: 1 },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'perm_done_1',
      decision: 'allow',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit user-action answer for a request already completed in session state', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {},
          completedRequests: {
            ask_done_1: { kind: 'user_action', tool: 'AskUserQuestion', status: 'approved', createdAt: 1 },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess_1',
      requestId: 'ask_done_1',
      decision: 'approve',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit permission response that targets a pending user-action request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            ask_pending_1: { kind: 'user_action', tool: 'AskUserQuestion', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'ask_pending_1',
      decision: 'allow',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit user-action answer that targets a pending permission request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            perm_pending_1: { kind: 'permission', tool: 'Write', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess_1',
      requestId: 'perm_pending_1',
      decision: 'approve',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('forwards an explicit permission response for a matching pending permission request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            perm_pending_ok_1: { kind: 'permission', tool: 'Write', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'perm_pending_ok_1',
      decision: 'allow',
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'sess_1:permission',
      request: { id: 'perm_pending_ok_1', approved: true },
    }));
  });

  it('returns schema-valid usage-limit recovery errors when the session transport cannot be resolved', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: false as const,
      code: 'session_not_found',
      candidates: ['sess_a', 'sess_b'],
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'missing',
    }))).toEqual({
      ok: false,
      status: 'not_found',
      sessionId: 'missing',
      errorCode: 'session_not_found',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('lets the active session runtime decide inline review provider support', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['claude'],
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: '',
      input,
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE}`,
      request: input,
    }));
  });

  describe('session.pendingInput.markHandled', () => {
    const blockedRow = {
      localId: 'local-1',
      status: 'queued',
      deliveryState: 'blocked',
      deliveryBlockedReason: 'delivery_outcome_uncertain',
      deliveryStatus: { status: 'blocked', reason: 'delivery_outcome_uncertain' },
      position: 0,
      content: { t: 'plain', v: 'proven elsewhere' },
    };
    const followerRow = {
      localId: 'local-2',
      status: 'queued',
      deliveryStatus: { status: 'queued' },
      position: 1,
      content: { t: 'plain', v: 'waiting behind the head' },
    };
    const expectedPreRead = {
      localId: 'local-1',
      status: 'queued',
      deliveryState: 'blocked',
      deliveryBlockedReason: 'delivery_outcome_uncertain',
      position: 0,
    };
    const expectation = { deliveryState: 'blocked', blockedReason: 'delivery_outcome_uncertain' };

    function sessionRecord(counts: Readonly<{ pendingCount: number; pendingBlockedCount: number; pendingVersion: number }>) {
      return {
        id: 'sess_1',
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        metadata: 'metadata',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        ...counts,
      };
    }

    function routeReads(params: Readonly<{
      pendingLists: ReadonlyArray<unknown>;
      session?: unknown;
      sessionError?: unknown;
    }>) {
      const pendingLists = [...params.pendingLists];
      mocks.axiosGet.mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.endsWith('/v2/sessions/sess_1/pending')) {
          const next = pendingLists.shift();
          if (next instanceof Error || (next && typeof next === 'object' && 'isAxiosError' in next)) throw next;
          return { status: 200, data: next };
        }
        if (url.endsWith('/v2/sessions/sess_1')) {
          if (params.sessionError) throw params.sessionError;
          return { status: 200, data: { session: params.session } };
        }
        throw new Error(`unexpected GET ${url}`);
      });
    }

    function getCalls(): string[] {
      return (mocks.axiosGet.mock.calls as unknown[][]).map((call) => String(call[0]));
    }

    function createMarkHandledDeps(options: Readonly<{ withCredentials: boolean }> = { withCredentials: true }) {
      return createCliActionDeps({
        token: 'ambient-token',
        ...(options.withCredentials ? { credentials: createCredentials() } : {}),
        sessionId: 'sess_1',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
        mode: 'plain',
        rawSession: { metadata: {} },
      });
    }

    it('refuses without any POST when the row is not in the expected delivery state', async () => {
      routeReads({
        pendingLists: [
          { pending: [blockedRow, followerRow] },
          { pending: [blockedRow, followerRow] },
          { pending: [blockedRow, followerRow] },
        ],
      });
      const deps = createMarkHandledDeps();

      await expect(deps.sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'delivering',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation: { deliveryState: 'delivering', blockedReason: null },
        claimsDelivery: false,
        outcome: 'refused',
        refusal: { reason: 'state_mismatch', row: expectedPreRead },
      });

      await expect(deps.sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'ambiguous_terminal_delivery',
      })).resolves.toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'state_mismatch', row: expectedPreRead },
      });

      await expect(deps.sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-absent',
        expectedDeliveryState: 'blocked',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-absent',
        expectation: { deliveryState: 'blocked', blockedReason: null },
        claimsDelivery: false,
        outcome: 'refused',
        refusal: { reason: 'row_missing' },
      });

      expect(mocks.axiosPost).not.toHaveBeenCalled();
    });

    it('refuses without any POST when the pre-read fails or credentials are absent', async () => {
      routeReads({
        pendingLists: [{ isAxiosError: true, code: 'ERR_BAD_REQUEST', response: { status: 404, data: { error: 'session-not-found' } } }],
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'pre_read_failed', httpStatus: 404, errorCode: 'ERR_BAD_REQUEST' },
      });

      mocks.axiosGet.mockClear();
      await expect(createMarkHandledDeps({ withCredentials: false }).sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'not_authenticated' },
      });
      expect(mocks.axiosGet).not.toHaveBeenCalled();
      expect(mocks.axiosPost).not.toHaveBeenCalled();
    });

    it('posts once with the CLI credentials and returns a resolved receipt proven by the readback', async () => {
      routeReads({
        pendingLists: [{ pending: [blockedRow, followerRow] }, { pending: [followerRow] }],
        session: sessionRecord({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: {
          ok: true,
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 9,
          message: {
            id: 'msg-1',
            seq: 41,
            localId: 'local-1',
            content: { t: 'plain', v: 'proven elsewhere' },
            deliveryResolution: { v: 1, kind: 'manual_handled' },
            createdAt: 1,
            updatedAt: 2,
          },
        },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'delivery_outcome_uncertain',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation,
        claimsDelivery: false,
        outcome: 'resolved',
        preRead: expectedPreRead,
        post: {
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 9,
          transcriptMessage: {
            id: 'msg-1',
            seq: 41,
            localId: 'local-1',
            deliveryResolution: { v: 1, kind: 'manual_handled' },
          },
        },
        readback: {
          pendingRows: { status: 'read', row: null, rowGoneFromQueuedList: true },
          sessionCounts: { status: 'read', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 },
        },
      });

      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
      expect(mocks.axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/sess_1/pending/local-1/delivery/handled'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
      );
      for (const call of mocks.axiosGet.mock.calls as unknown[][]) {
        expect(call[1]).toEqual(expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        }));
      }
      expect(getCalls().filter((url) => url.endsWith('/pending'))).toHaveLength(2);
    });

    it('reports a not-resolved receipt when the server answers without resolving the row', async () => {
      routeReads({
        pendingLists: [{ pending: [blockedRow, followerRow] }, { pending: [blockedRow, followerRow] }],
        session: sessionRecord({ pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: { ok: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'delivery_outcome_uncertain',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation,
        claimsDelivery: false,
        outcome: 'not_resolved',
        preRead: expectedPreRead,
        post: { pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 },
        readback: {
          pendingRows: { status: 'read', row: expectedPreRead, rowGoneFromQueuedList: false },
          sessionCounts: { status: 'read', pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('reports a transcript conflict as a rejected receipt with the row state read back', async () => {
      const reblockedRow = {
        ...blockedRow,
        deliveryBlockedReason: 'unknown',
        deliveryStatus: { status: 'blocked', reason: 'unknown' },
      };
      routeReads({
        pendingLists: [{ pending: [blockedRow, followerRow] }, { pending: [reblockedRow, followerRow] }],
        session: sessionRecord({ pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 9 }),
      });
      mocks.axiosPost.mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        response: { status: 409, data: { error: 'transcript-conflict' } },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'delivery_outcome_uncertain',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation,
        claimsDelivery: false,
        outcome: 'rejected',
        preRead: expectedPreRead,
        post: { errorKind: 'transcript_conflict', httpStatus: 409, serverError: 'transcript-conflict' },
        readback: {
          pendingRows: {
            status: 'read',
            row: { ...expectedPreRead, deliveryBlockedReason: 'unknown' },
            rowGoneFromQueuedList: false,
          },
          sessionCounts: { status: 'read', pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 9 },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('reports a transport failure as uncertain and never retries the POST', async () => {
      routeReads({
        pendingLists: [
          { pending: [blockedRow, followerRow] },
          { isAxiosError: true, code: 'ECONNREFUSED' },
        ],
        sessionError: { isAxiosError: true, code: 'ECONNREFUSED' },
      });
      mocks.axiosPost.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNABORTED' });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation: { deliveryState: 'blocked', blockedReason: null },
        claimsDelivery: false,
        outcome: 'uncertain',
        preRead: expectedPreRead,
        post: { errorKind: 'transport_failure', httpStatus: null, errorCode: 'ECONNABORTED' },
        readback: {
          pendingRows: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' },
          sessionCounts: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('treats a server error or unreadable success body as uncertain rather than rejected', async () => {
      routeReads({
        pendingLists: [{ pending: [blockedRow] }, { pending: [] }],
        session: sessionRecord({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 }),
      });
      mocks.axiosPost.mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ERR_BAD_RESPONSE',
        response: { status: 500, data: { error: 'internal' } },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'uncertain',
        post: { errorKind: 'non_final_status', httpStatus: 500, errorCode: 'ERR_BAD_RESPONSE' },
        readback: { pendingRows: { status: 'read', row: null, rowGoneFromQueuedList: true } },
      });

      routeReads({
        pendingLists: [{ pending: [blockedRow] }, { pending: [] }],
        session: sessionRecord({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: {
          ok: true,
          pendingCount: 0,
          pendingBlockedCount: 0,
          pendingVersion: 10,
          message: { id: 'msg-1', seq: 41, localId: 'local-other', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'uncertain',
        post: { errorKind: 'malformed_response', httpStatus: null, errorCode: 'invalid_response_shape' },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    });

    // The server's projection of a queued row whose stored requested action it cannot parse
    // (mapPendingMessageRow): typed blocked `unsupported_action` over unchanged persisted fields.
    const unsupportedActionFollowerRow = {
      localId: 'local-2',
      requestedActionMalformed: true,
      status: 'queued',
      deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
      position: 1,
      content: { t: 'plain', v: 'stored with an unreadable action' },
      discardedReason: null,
    };

    it('posts once for an eligible row beside a server-projected unsupported-action row and reads it back', async () => {
      routeReads({
        pendingLists: [
          { pending: [blockedRow, unsupportedActionFollowerRow] },
          { pending: [unsupportedActionFollowerRow] },
        ],
        session: sessionRecord({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: {
          ok: true,
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 9,
          message: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'delivery_outcome_uncertain',
      })).resolves.toMatchObject({
        outcome: 'resolved',
        preRead: expectedPreRead,
        readback: {
          pendingRows: { status: 'read', row: null, rowGoneFromQueuedList: true },
          sessionCounts: { status: 'read', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('reads a server-projected unsupported-action row back by its persisted fields', async () => {
      const projectedTargetRow = {
        ...blockedRow,
        requestedActionMalformed: true,
        deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
      };
      routeReads({
        pendingLists: [
          { pending: [blockedRow, followerRow] },
          { pending: [projectedTargetRow, unsupportedActionFollowerRow] },
        ],
        session: sessionRecord({ pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 9 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: { ok: true, pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 9 },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'delivery_outcome_uncertain',
      })).resolves.toMatchObject({
        outcome: 'not_resolved',
        post: { pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 9 },
        readback: {
          pendingRows: { status: 'read', row: expectedPreRead, rowGoneFromQueuedList: false },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('guards on the persisted fields of a server-projected row, never on its typed projection', async () => {
      const projectedTargetRow = { ...unsupportedActionFollowerRow, localId: 'local-1', position: 0 };
      routeReads({ pendingLists: [{ pending: [projectedTargetRow] }] });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
        expectedBlockedReason: 'unsupported_action',
      })).resolves.toMatchObject({
        outcome: 'refused',
        refusal: {
          reason: 'state_mismatch',
          row: { localId: 'local-1', status: 'queued', deliveryState: null, deliveryBlockedReason: null, position: 0 },
        },
      });
      expect(mocks.axiosPost).not.toHaveBeenCalled();
    });

    it.each([
      ['nothing but ok', { ok: true }],
      ['no counts', { ok: true, pendingVersion: 8 }],
      ['invalid counts', { ok: true, pendingCount: -1, pendingBlockedCount: 'one', pendingVersion: 8 }],
    ])('reports a success body with no message and %s as uncertain, even when every readback fails', async (_case, data) => {
      routeReads({
        pendingLists: [
          { pending: [blockedRow, followerRow] },
          { isAxiosError: true, code: 'ECONNREFUSED' },
        ],
        sessionError: { isAxiosError: true, code: 'ECONNREFUSED' },
      });
      mocks.axiosPost.mockResolvedValueOnce({ data });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toEqual({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectation: { deliveryState: 'blocked', blockedReason: null },
        claimsDelivery: false,
        outcome: 'uncertain',
        preRead: expectedPreRead,
        post: { errorKind: 'malformed_response', httpStatus: null, errorCode: 'invalid_response_shape' },
        readback: {
          pendingRows: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' },
          sessionCounts: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('reports a success body with no message and incomplete counts as uncertain when the readback succeeds', async () => {
      routeReads({
        pendingLists: [{ pending: [blockedRow, followerRow] }, { pending: [blockedRow, followerRow] }],
        session: sessionRecord({ pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({ data: { ok: true, pendingCount: 2, pendingVersion: 8 } });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'uncertain',
        post: { errorKind: 'malformed_response', httpStatus: null, errorCode: 'invalid_response_shape' },
        readback: {
          pendingRows: { status: 'read', row: expectedPreRead, rowGoneFromQueuedList: false },
          sessionCounts: { status: 'read', pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 },
        },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('reports a validated committed message as resolved even when the success body has no counts', async () => {
      routeReads({
        pendingLists: [{ pending: [blockedRow] }, { isAxiosError: true, code: 'ECONNREFUSED' }],
        sessionError: { isAxiosError: true, code: 'ECONNREFUSED' },
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: {
          ok: true,
          message: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'blocked',
      })).resolves.toMatchObject({
        outcome: 'resolved',
        post: {
          pendingCount: null,
          pendingBlockedCount: null,
          pendingVersion: null,
          transcriptMessage: { id: 'msg-1', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
        readback: { pendingRows: { status: 'failed', httpStatus: null, errorCode: 'ECONNREFUSED' } },
      });
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('accepts an external handoff row as the expected state', async () => {
      const handoffRow = {
        localId: 'local-1',
        status: 'queued',
        deliveryState: 'external_handoff',
        deliveryStatus: { status: 'external_handoff' },
        position: 0,
      };
      routeReads({
        pendingLists: [{ pending: [handoffRow] }, { pending: [] }],
        session: sessionRecord({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 }),
      });
      mocks.axiosPost.mockResolvedValueOnce({
        data: {
          ok: true,
          pendingCount: 0,
          pendingBlockedCount: 0,
          pendingVersion: 4,
          message: { id: 'msg-2', seq: 7, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
        },
      });

      await expect(createMarkHandledDeps().sessionPendingInputMarkHandled?.({
        sessionId: 'sess_1',
        localId: 'local-1',
        expectedDeliveryState: 'external_handoff',
      })).resolves.toMatchObject({
        outcome: 'resolved',
        preRead: { localId: 'local-1', status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null, position: 0 },
        readback: { pendingRows: { status: 'read', row: null, rowGoneFromQueuedList: true } },
      });
    });
  });
  it.each([
    { active: true, machineId: 'machine-local', metadataMachineId: 'machine-local' },
    { active: false, machineId: 'machine-local', metadataMachineId: 'machine-local' },
    { active: true, machineId: 'machine-remote', metadataMachineId: 'machine-remote' },
    { active: true, machineId: 'machine-local', metadataMachineId: 'machine-other' },
  ])('checks daemon ownership before routing an owned CLI check ($active, $machineId, $metadataMachineId)', async ({ active, machineId, metadataMachineId }) => {
    const recovery = { v: 1, status: 'waiting', issueFingerprint: 'attempt',
      runtimeAuthRecoveryAttemptId: 'attempt', armedAtMs: 1, resetAtMs: 2, nextCheckAtMs: 2,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard',
      selectedAuth: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' } };
    mocks.resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'sess_1',
      rawSession: { active, machineId, metadata: { machineId: metadataMachineId,
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' }, sessionUsageLimitRecoveryV1: recovery } },
      ctx: { encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'legacy' }, mode: 'plain' });
    mocks.callMachineRpc.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'sess_1' });
    const deps = createCliActionDeps({ token: 'token', credentials: createCredentials(), sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }, mode: 'plain', rawSession: { metadata: {} } });
    const result = await deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1', resumePromptMode: 'custom' });
    if (metadataMachineId !== machineId) {
      expect(result).toMatchObject({ ok: false, errorCode: 'session_usage_limit_recovery_control_remote_unavailable' });
      expect(mocks.callMachineRpc).not.toHaveBeenCalled();
      expect(mocks.callSessionRpc).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ ok: true, status: 'waiting' });
    expect(mocks.callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId, method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
      request: { sessionId: 'sess_1', resumePromptMode: 'custom' },
      authorization: { kind: 'session.write', sessionId: 'sess_1' },
    }));
    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

});
