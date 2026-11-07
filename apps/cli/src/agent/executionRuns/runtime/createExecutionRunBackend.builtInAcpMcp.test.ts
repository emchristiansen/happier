import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, McpServerConfig, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendFactoryOptions } from '@/agent/executionRuns/registry/executionRunBackendTypes';

const getExecutionRunBackendDescriptorMock = vi.fn();
const readCredentialsMock = vi.fn();
const readSettingsMock = vi.fn();
const resolveCustomHappierToolsContextMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
  readSettings: readSettingsMock,
}));

vi.mock('@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext', () => ({
  resolveCustomHappierToolsContext: resolveCustomHappierToolsContextMock,
}));

describe('createExecutionRunBackend built-in ACP MCP context', () => {
  beforeEach(() => {
    getExecutionRunBackendDescriptorMock.mockReset();
    readCredentialsMock.mockReset();
    readSettingsMock.mockReset();
    resolveCustomHappierToolsContextMock.mockReset();
  });

  it('provides the canonical Happier MCP servers to a built-in backend with one resolution', async () => {
    const mcpServers = {
      happier: { command: 'happier-mcp', args: ['bridge'] },
    } satisfies Record<string, McpServerConfig>;
    const captured: { first?: Readonly<Record<string, McpServerConfig>>; second?: Readonly<Record<string, McpServerConfig>> } = {};

    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: (options: ExecutionRunBackendFactoryOptions): AgentBackend => ({
        async startSession() {
          captured.first = await options.resolveMcpServers?.();
          captured.second = await options.resolveMcpServers?.();
          return { sessionId: 'agy-run-session' as SessionId };
        },
        async sendPrompt() {},
        async cancel() {},
        onMessage() {},
        async dispose() {},
      }),
    });
    readCredentialsMock.mockResolvedValue({ token: 'credential-token' });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers, warnings: [] });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    const accountSettings = { mcpServersSettingsV1: { v: 1, strictMode: false, servers: [], bindings: [] } };
    const backend = createExecutionRunBackend({
      cwd: '/workspace',
      backendId: 'agy',
      backendTarget: { kind: 'builtInAgent', agentId: 'agy' },
      permissionMode: 'read_only',
      accountSettings,
    });

    await backend.startSession();

    expect(captured.first).toBe(mcpServers);
    expect(captured.second).toBe(mcpServers);
    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(readSettingsMock).toHaveBeenCalledTimes(1);
    expect(resolveCustomHappierToolsContextMock).toHaveBeenCalledTimes(1);
    expect(resolveCustomHappierToolsContextMock).toHaveBeenCalledWith({
      credentials: { token: 'credential-token' },
      accountSettings,
      machineId: 'machine-1',
      directory: '/workspace',
    });
  });
});
