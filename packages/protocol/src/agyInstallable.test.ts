import { describe, expect, it } from 'vitest';

import { INSTALLABLES_CATALOG, INSTALLABLE_KEYS } from './installables.js';

describe('agy-acp-server installable (EU-3)', () => {
  it('registers the pinned agy ACP server as a managed installable', () => {
    expect(INSTALLABLE_KEYS.AGY_ACP_SERVER).toBe('agy-acp-server');
    const entry = INSTALLABLES_CATALOG.find((item) => item.key === INSTALLABLE_KEYS.AGY_ACP_SERVER);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      key: 'agy-acp-server',
      kind: 'dep',
      capabilityId: 'dep.agy-acp-server',
      defaultPolicy: { autoInstallWhenNeeded: true },
    });
  });
});
