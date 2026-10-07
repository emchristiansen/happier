import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createCatalogDefinedAcpBackend, prepareDevinMcpProcessLaunch } = vi.hoisted(() => ({
  createCatalogDefinedAcpBackend: vi.fn(() => ({ dispose: vi.fn() })),
  prepareDevinMcpProcessLaunch: vi.fn(async () => ({
    env: { XDG_CONFIG_HOME: '/tmp/happier-devin' },
    cleanup: vi.fn(),
  })),
}));

vi.mock('@/agent/acp/catalog/createCatalogDefinedAcpBackend', () => ({
  createCatalogDefinedAcpBackend,
}));
vi.mock('../mcp/prepareDevinMcpProcessLaunch', () => ({
  prepareDevinMcpProcessLaunch,
}));

import { createDevinBackend } from './backend';

describe('createDevinBackend', () => {
  beforeEach(() => {
    createCatalogDefinedAcpBackend.mockClear();
    prepareDevinMcpProcessLaunch.mockClear();
  });

  it('materializes Happier MCP servers through a Devin process-scoped config overlay', async () => {
    const mcpServers = { happier: { command: 'happier-mcp', args: ['bridge'] } };
    createDevinBackend({
      cwd: '/workspace',
      env: { DEVIN_TEST_ENV: 'scoped' },
      mcpServers,
    });

    expect(createCatalogDefinedAcpBackend).toHaveBeenCalledWith('devin', expect.objectContaining({
      mcpServers,
      prepareProcessLaunch: expect.any(Function),
      sessionModelAdapter: expect.objectContaining({
        projectModelState: expect.any(Function),
        deriveModelStateFromConfigOptions: expect.any(Function),
        resolveConfigOptionModelUpdate: expect.any(Function),
      }),
    }));

    const calls = createCatalogDefinedAcpBackend.mock.calls as unknown as Array<[
      string,
      { prepareProcessLaunch?: () => Promise<unknown> },
    ]>;
    const passedOptions = calls[0]?.[1];
    await passedOptions?.prepareProcessLaunch?.();
    expect(prepareDevinMcpProcessLaunch).toHaveBeenCalledWith({
      cwd: '/workspace',
      processEnv: expect.objectContaining({ DEVIN_TEST_ENV: 'scoped' }),
      mcpServers,
    });
  });

  it('resolves execution-run MCP servers when preparing the Devin process launch', async () => {
    const mcpServers = { happier: { command: 'happier-mcp', args: ['bridge'] } };
    const resolveMcpServers = vi.fn(async () => mcpServers);
    createDevinBackend({
      cwd: '/workspace',
      env: { DEVIN_CONFIG_DIR: '/isolated/devin' },
      resolveMcpServers,
    });

    const calls = createCatalogDefinedAcpBackend.mock.calls as unknown as Array<[
      string,
      { prepareProcessLaunch?: () => Promise<unknown> },
    ]>;
    await calls[0]?.[1].prepareProcessLaunch?.();

    expect(resolveMcpServers).toHaveBeenCalledTimes(1);
    expect(prepareDevinMcpProcessLaunch).toHaveBeenCalledWith({
      cwd: '/workspace',
      processEnv: expect.objectContaining({ DEVIN_CONFIG_DIR: '/isolated/devin' }),
      mcpServers,
    });
  });
});
