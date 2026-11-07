import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import type { AgentBackend, McpServerConfig } from '@/agent/core';

import { prepareDevinMcpProcessLaunch } from '../mcp/prepareDevinMcpProcessLaunch';
import { devinSessionModelAdapter } from './modelControls';

export type DevinBackendOptions = CatalogDefinedAcpBackendOptions & Readonly<{
  resolveMcpServers?: () => Promise<Readonly<Record<string, McpServerConfig>>>;
}>;

export function createDevinBackend(options: DevinBackendOptions): AgentBackend {
  const { resolveMcpServers, ...backendOptions } = options;
  const mcpServers = options.mcpServers ?? {};
  const processEnv = { ...process.env, ...options.env };
  return createCatalogDefinedAcpBackend('devin', {
    ...backendOptions,
    sessionModelAdapter: devinSessionModelAdapter,
    prepareProcessLaunch: async () => prepareDevinMcpProcessLaunch({
      cwd: options.cwd,
      processEnv,
      mcpServers: await resolveMcpServers?.() ?? mcpServers,
    }),
  });
}
