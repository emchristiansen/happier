import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import {
  getOptionalRuntimeStatus,
  installOptionalRuntime,
  type OptionalRuntimeKey,
} from '@/installables/runtime/optionalRuntimeInstallables';

import { CapabilityError } from '../errors';
import type { Capability } from '../service';

function optionalRuntimeCapability(key: OptionalRuntimeKey, title: string): Capability {
  return {
    descriptor: {
      id: `dep.${key}`,
      kind: 'dep',
      title,
      methods: { install: { title: 'Install' }, upgrade: { title: 'Reinstall' } },
    },
    detect: () => getOptionalRuntimeStatus(key),
    invoke: async ({ method }) => {
      if (method !== 'install' && method !== 'upgrade') throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
      const result = await installOptionalRuntime(key);
      return result.ok
        ? { ok: true, result: { logPath: result.logPath } }
        : { ok: false, error: { code: 'install-failed', message: result.errorMessage }, ...(result.logPath ? { logPath: result.logPath } : {}) };
    },
  };
}

export const optionalRuntimeCapabilities = [
  optionalRuntimeCapability(INSTALLABLE_KEYS.LOCAL_EMBEDDINGS, 'Local semantic memory'),
  optionalRuntimeCapability(INSTALLABLE_KEYS.DIFFTASTIC, 'Difftastic'),
];
