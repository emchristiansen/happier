import { AGY_ACP_SERVER_DEP_ID } from '@happier-dev/protocol/installables';

import type { Capability } from '../service';
import { CapabilityError } from '../errors';
import { getAgyAcpDepStatus, installAgyAcp } from '../deps/agyAcp';

export const agyAcpDepCapability: Capability = {
  descriptor: {
    id: AGY_ACP_SERVER_DEP_ID,
    kind: 'dep',
    title: 'Agy ACP server',
    methods: {
      install: { title: 'Install' },
      upgrade: { title: 'Upgrade' },
    },
  },
  detect: async ({ request }) => {
    const includeLatestVersion = Boolean((request.params ?? {}).includeLatestVersion);
    const onlyIfInstalled = Boolean((request.params ?? {}).onlyIfInstalled);
    return await getAgyAcpDepStatus({ includeLatestVersion, onlyIfInstalled });
  },
  invoke: async ({ method }) => {
    if (method !== 'install' && method !== 'upgrade') {
      throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
    }
    // Joins the existing in-flight install shared with launch-side ensure.
    const result = await installAgyAcp();
    if (!result.ok) {
      return { ok: false, error: { message: result.errorMessage, code: 'install-failed' }, logPath: result.logPath };
    }
    return { ok: true, result: { logPath: result.logPath } };
  },
};
