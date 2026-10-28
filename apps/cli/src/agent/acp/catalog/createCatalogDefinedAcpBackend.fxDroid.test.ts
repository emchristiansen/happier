import { describe, expect, it, vi } from 'vitest';

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: (agentId: string) => ({ command: `/resolved/${agentId}`, args: [] }),
}));

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';

describe('catalog-defined FX and Factory Droid ACP backends', () => {
  it.each([
    ['fx', '/resolved/fx', ['acp']],
    ['droid', '/resolved/droid', ['exec', '--output-format', 'acp']],
  ] as const)('launches %s through its official ACP command', (agentId, command, args) => {
    const backend = createCatalogDefinedAcpBackend(agentId as never, { cwd: '/workspace' });

    expect(backend).toMatchObject({ options: { command, args, declaredSessionLoadSupport: true } });
    expect(backend.loadSession).toBeTypeOf('function');
  });
});
