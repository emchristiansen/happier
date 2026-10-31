import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';

import { createDevinBackend } from './acp/backend';

const genericEntry = createCatalogDefinedAcpEntry('devin');

export const agent = {
  ...genericEntry,
  getAcpBackendFactory: async () => {
    return (opts: unknown) => ({ backend: createDevinBackend(opts as Parameters<typeof createDevinBackend>[0]) });
  },
  getAcpRuntimeSessionModelAdapter: async () => {
    const {
      buildDevinSessionModelsFromConfigOptions,
      resolveDevinSessionConfigOptionUpdate,
      resolveDevinSessionModelConfigUpdate,
    } = await import('./acp/modelControls');
    return {
      deriveSessionModelsFromConfigOptions: buildDevinSessionModelsFromConfigOptions,
      resolveSessionModelConfigUpdate: resolveDevinSessionModelConfigUpdate,
      resolveSessionConfigOptionUpdate: resolveDevinSessionConfigOptionUpdate,
    };
  },
};
