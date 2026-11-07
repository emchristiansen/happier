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
      isBunRuntime: false,
      dependencies: {
        resolveInvocation: async () => ({ command: '/usr/bin/node', args: ['/codex.js', '--version'] }),
        execute,
      },
    });

    expect(result.ok).toBe(expected);
    expect(execute).toHaveBeenCalledWith('/usr/bin/node', ['/codex.js', '--version'], {});
  });

  it.each(['linux', 'darwin'] as const)('keeps Bun runners on the stdio app-server on %s', async (platform) => {
    const execute = vi.fn(() => 'codex-cli 0.162.1');
    const result = await resolveCodexSharedControlSupport({
      cwd: '/workspace',
      processEnv: {},
      platform,
      isBunRuntime: true,
      dependencies: {
        resolveInvocation: async () => ({ command: '/usr/bin/codex', args: ['--version'] }),
        execute,
      },
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported-runtime' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('detects the current runtime when the caller does not say', async () => {
    const result = await resolveCodexSharedControlSupport({
      cwd: '/workspace',
      processEnv: {},
      platform: 'linux',
      dependencies: {
        resolveInvocation: async () => ({ command: '/usr/bin/codex', args: ['--version'] }),
        execute: () => 'codex-cli 0.162.1',
      },
    });

    expect(result.ok).toBe(typeof process.versions.bun !== 'string');
  });
});
