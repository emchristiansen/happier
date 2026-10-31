import type { ProviderAttachOps } from '@/backends/types';
import { configuration } from '@/configuration';

import { evaluateCodexProviderAttachEligibility } from './evaluateCodexProviderAttachEligibility';
import { runCodexProviderAttach } from './runCodexProviderAttach';
import { readCodexSharedControlEndpoint } from '../localControl/codexSharedControlEndpoint';

export const codexProviderAttachOps: ProviderAttachOps = {
  evaluateEligibility: async (params) => evaluateCodexProviderAttachEligibility({
    ...params,
    hasLocalSharedControlEndpoint: await readCodexSharedControlEndpoint({
      happyHomeDir: configuration.happyHomeDir,
      sessionId: params.sessionId,
    }) !== null,
  }),
  runAttach: runCodexProviderAttach,
};
