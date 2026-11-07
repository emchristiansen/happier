import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCatalogProviderAcpRuntimeMock,
  getProviderCliRuntimeSpecMock,
  runStandardAcpProviderMock,
} = vi.hoisted(() => ({
  createCatalogProviderAcpRuntimeMock: vi.fn(),
  getProviderCliRuntimeSpecMock: vi.fn(),
  runStandardAcpProviderMock: vi.fn(),
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    getProviderCliRuntimeSpec: getProviderCliRuntimeSpecMock,
  };
});

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

vi.mock('@/agent/acp/runtime/createCatalogProviderAcpRuntime', () => ({
  createCatalogProviderAcpRuntime: createCatalogProviderAcpRuntimeMock,
}));

vi.mock('./ui/CatalogDefinedAcpTerminalDisplay', () => ({
  CatalogDefinedAcpTerminalDisplay: () => null,
}));

import { runCatalogDefinedAcpAgent } from './runCatalogDefinedAcpAgent';

describe('runCatalogDefinedAcpAgent', () => {
  beforeEach(() => {
    createCatalogProviderAcpRuntimeMock.mockReset();
    getProviderCliRuntimeSpecMock.mockReset();
    runStandardAcpProviderMock.mockReset();
    getProviderCliRuntimeSpecMock.mockReturnValue({
      title: 'Kiro CLI',
      binaryName: 'kiro',
    });
  });

  it('forwards machine identity and memory recall guidance to the catalog ACP runtime', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });

    const runtime = { kind: 'runtime' };
    createCatalogProviderAcpRuntimeMock.mockReturnValue(runtime);

    await runCatalogDefinedAcpAgent('kiro', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig) {
      throw new Error('Expected ACP runtime config to be captured');
    }

    const runtimeConfig = capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>;
    expect(runtimeConfig).not.toHaveProperty('runtimeActivityApplicability');
    const createdRuntime = runtimeConfig.createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: { id: 'session-1' },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: true,
    });

    expect(createdRuntime).toBe(runtime);
    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'kiro',
      directory: '/repo',
      session: { id: 'session-1' },
      memoryRecallGuidance: {
        enabled: true,
        machineId: 'machine-123',
      },
    }));
  });

  it('lets the Grok catalog entry attach its live-session notification adapter without a shared provider branch', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });
    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runCatalogDefinedAcpAgent('grok', {
      credentials: { token: 'token' } as any,
    });
    if (!capturedConfig) throw new Error('Expected ACP runtime config to be captured');
    const session = {
      sessionId: 'happier-session',
      updateMetadata: vi.fn(),
      upsertSessionSystemRecord: vi.fn(),
      fetchSessionSystemRecord: vi.fn(),
      getStoredContentEncryptionContext: vi.fn(() => ({ mode: 'plain' })),
    };
    (capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>).createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session,
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'grok',
      backendOptions: {
        sessionNotificationObserver: expect.any(Function),
      },
    }));
  });

  it('lets the Devin catalog entry attach its model config projection without a shared provider branch', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });
    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runCatalogDefinedAcpAgent('devin', {
      credentials: { token: 'token' } as any,
    });
    if (!capturedConfig) throw new Error('Expected ACP runtime config to be captured');
    (capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>).createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: {},
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'devin',
      deriveSessionModelsFromConfigOptions: expect.any(Function),
      resolveSessionModelConfigUpdate: expect.any(Function),
      resolveSessionConfigOptionUpdate: expect.any(Function),
    }));
  });

  /**
   * Every built-in ACP agent declares `session/load`. Without forwarding that declaration the
   * shared runner keeps its new-session fallback, so a failed `session/load` would silently
   * create a fresh vendor session for Devin, Agy, FX, Droid, Kimi, Kiro, and Custom ACP.
   */
  it.each(['kiro', 'devin', 'agy', 'fx', 'droid', 'kimi', 'customAcp'] as const)(
    'forwards the built-in ACP session-load declaration for %s so explicit resume fails closed',
    async (agentId) => {
      let capturedConfig: null | Readonly<{ declaredSessionLoadSupport?: boolean }> = null;
      runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
        capturedConfig = config as Readonly<{ declaredSessionLoadSupport?: boolean }>;
      });
      createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

      await runCatalogDefinedAcpAgent(agentId, { credentials: { token: 'token' } as any });

      expect(capturedConfig).toMatchObject({ declaredSessionLoadSupport: true });
    },
  );
});
