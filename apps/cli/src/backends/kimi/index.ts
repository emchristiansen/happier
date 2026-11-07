import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import type { AgentCatalogEntry } from '../types';

const genericEntry = createCatalogDefinedAcpEntry('kimi');

export const agent = {
  ...genericEntry,
  id: AGENTS_CORE.kimi.id,
  cliSubcommand: AGENTS_CORE.kimi.cliSubcommand,
  getCliCapabilityOverride: async () => (await import('@/backends/kimi/cli/capability')).cliCapability,
  getAcpBackendFactory: async () => {
    const { createKimiBackend } = await import('@/backends/kimi/acp/backend');
    return (opts) => ({ backend: createKimiBackend(opts as never) });
  },
  checklists,
} satisfies AgentCatalogEntry;
