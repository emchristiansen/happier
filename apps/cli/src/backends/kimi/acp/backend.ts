import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import type { AgentBackend } from '@/agent/core';
import { requireCurrentKimiRuntime } from '@/backends/kimi/cli/runtimeDiscovery';

export type KimiBackendOptions = CatalogDefinedAcpBackendOptions;

/** Current Kimi uses the shared ACP backend; only executable classification is provider-owned. */
export function createKimiBackend(options: KimiBackendOptions): AgentBackend {
  return createCatalogDefinedAcpBackend('kimi', {
    ...options,
    prepareProcessLaunch: async () => {
      const runtime = await requireCurrentKimiRuntime({
        processEnv: { ...process.env, ...options.env },
        cwd: options.cwd,
      });
      return { command: runtime.command, args: ['acp'] };
    },
  });
}
