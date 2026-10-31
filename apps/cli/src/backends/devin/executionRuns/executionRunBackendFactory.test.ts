import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend } from '@/agent/core';

const { createDevinBackendMock } = vi.hoisted(() => ({
  createDevinBackendMock: vi.fn(),
}));

vi.mock('@/backends/devin/acp/backend', () => ({
  createDevinBackend: createDevinBackendMock,
}));

import { executionRunBackendFactory } from './executionRunBackendFactory';

describe('Devin executionRunBackendFactory', () => {
  it('routes the execution-run MCP resolver into Devin native MCP preparation', () => {
    createDevinBackendMock.mockReturnValue({
      startSession: vi.fn(),
      sendPrompt: vi.fn(),
      cancel: vi.fn(),
      onMessage: vi.fn(),
      dispose: vi.fn(),
    } satisfies AgentBackend);
    const resolveMcpServers = vi.fn(async () => ({
      happier: { command: 'happier-mcp', args: ['bridge'] },
    }));

    executionRunBackendFactory({
      cwd: '/workspace',
      backendId: 'devin',
      permissionMode: 'read_only',
      permissionHandler: { handleToolCall: vi.fn() },
      resolveMcpServers,
    });

    expect(createDevinBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace',
      resolveMcpServers,
    }));
  });
});
