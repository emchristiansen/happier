import { describe, expect, it, vi } from 'vitest';

import { resolveCodexSharedControlSupport } from './resolveCodexSharedControlSupport';

describe('resolveCodexSharedControlSupport', () => {
  it.each([
    ['linux', 'codex-cli 0.131.0', true],
    ['darwin', 'codex-cli 0.131.0', true],
    ['linux', 'codex-cli 0.130.0', false],
    ['win32', 'codex-cli 0.153.0', false],
    ['win32', 'codex-cli 0.154.0', false],
    ['win32', 'codex-cli 0.999.0', false],
    ['linux', 'unexpected', false],
  ] as const)('uses the first safe shared app-server release on %s: %s', async (platform, raw, expected) => {
    const execute = vi.fn(() => raw);
    const result = await resolveCodexSharedControlSupport({
      cwd: '/workspace',
      processEnv: {},
      platform,
      dependencies: {
        resolveInvocation: async () => ({ command: '/usr/bin/node', args: ['/codex.js', '--version'] }),
        execute,
      },
    });

    expect(result.ok).toBe(expected);
    expect(execute).toHaveBeenCalledWith('/usr/bin/node', ['/codex.js', '--version'], {});
  });
});
