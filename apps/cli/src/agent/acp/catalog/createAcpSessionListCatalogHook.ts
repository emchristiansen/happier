import { isAcpSessionListingDeclared, type AgentId } from '@happier-dev/agents';

import type { AgentCatalogEntry } from '@/backends/types';

type AcpSessionListCatalogHook = Pick<AgentCatalogEntry, 'getDirectSessionProviderOps'>;

/** Projects the shared ACP session-list declaration into a lazily loaded CLI catalog hook. */
export function createAcpSessionListCatalogHook(agentId: AgentId): AcpSessionListCatalogHook | Record<string, never> {
  if (!isAcpSessionListingDeclared(agentId)) return {};

  return {
    getDirectSessionProviderOps: async () => {
      const { createAcpSessionListDirectSessionProviderOps } = await import(
        '@/backends/directSessions/acpSessionListProviderOps'
      );
      return createAcpSessionListDirectSessionProviderOps(agentId);
    },
  };
}
