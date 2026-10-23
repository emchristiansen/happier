import { stripVTControlCharacters } from 'node:util';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const ORIGIN = 'http://happier-connect-status.test';

function captureConsole(): Readonly<{ out: () => string[]; err: () => string[]; restore: () => void }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(...stripVTControlCharacters(args.map(String).join(' ')).split('\n'));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(stripVTControlCharacters(args.map(String).join(' ')));
  });
  return { out: () => out, err: () => err, restore: () => { log.mockRestore(); error.mockRestore(); } };
}

// Each test imports the connect command afresh (after vi.resetModules), which loads a large module
// graph; on a loaded host that cold import alone has taken close to the 30 s default.
const CONNECT_IMPORT_TIMEOUT_MS = 120_000;

describe('happier connect status', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_VARIANT', 'DEBUG'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let homeDir = '';

  beforeEach(async () => {
    envScope = createEnvKeyScope(envKeys);
    homeDir = await createTempDir('happier-cli-connect-status-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: ORIGIN,
      HAPPIER_LOCAL_SERVER_URL: ORIGIN,
      HAPPIER_VARIANT: 'stable',
      DEBUG: undefined,
    });
    vi.resetModules();
  });

  afterEach(async () => {
    envScope.restore();
    vi.restoreAllMocks();
    vi.resetModules();
    await removeTempDir(homeDir);
  });

  it.each([
    ['--profile has no value', ['status', '--profile']],
    ['--profile is empty', ['status', '--profile', '']],
    ['--profile is followed by a short flag', ['status', '--profile', '-h']],
    ['--profile is followed by a long flag', ['status', '--profile', '--json']],
  ])('exits 1 with a usage error when %s, before any status work', async (_case, args) => {
    const consoleCapture = captureConsole();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    try {
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(args)).rejects.toThrow('process.exit:1');
      expect(consoleCapture.err().join('\n')).toContain('Usage: happier connect status --profile <id>');
      expect(consoleCapture.out().join('\n')).not.toContain('Connection Status');
    } finally {
      exitSpy.mockRestore();
      consoleCapture.restore();
    }
  }, CONNECT_IMPORT_TIMEOUT_MS);

  it('lists every profile the server returns, with health, and filters by --profile', async () => {
    const app = fastify({ logger: false });
    const requestedServiceIds: string[] = [];
    app.get<{ Params: { serviceId: string } }>('/v2/connect/:serviceId/profiles', async (request) => {
      requestedServiceIds.push(request.params.serviceId);
      if (request.params.serviceId === 'openai-codex') {
        return {
          serviceId: 'openai-codex',
          profiles: [
            {
              profileId: 'work',
              status: 'needs_reauth',
              kind: 'oauth',
              providerEmail: 'work@example.com',
              expiresAt: Date.UTC(2026, 9, 1),
              health: { v: 1, status: 'needs_reauth', reconnectRequired: true, lastRefreshFailureKind: 'invalid_grant' },
            },
            { profileId: 'alt', status: 'connected', kind: 'oauth', providerEmail: 'alt@example.com', health: null },
          ],
        };
      }
      if (request.params.serviceId === 'github') {
        return { serviceId: 'github', profiles: [{ profileId: 'work', status: 'connected', kind: 'token' }] };
      }
      return { serviceId: request.params.serviceId, profiles: [] };
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: ORIGIN });
    try {
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token: 'happy-token' });
      const { handleConnectCommand } = await import('./connect');

      const all = captureConsole();
      try {
        await handleConnectCommand(['status']);
      } finally {
        all.restore();
      }
      const allOut = all.out();
      const codexAlt = allOut.indexOf('      openai-codex/alt: connected');
      const codexWork = allOut.indexOf('      openai-codex/work: needs_reauth');
      expect(codexAlt).toBeGreaterThan(-1);
      expect(codexWork).toBeGreaterThan(codexAlt);
      expect(allOut.slice(codexWork + 1, codexWork + 6)).toEqual([
        '        kind: oauth',
        '        email: work@example.com',
        '        expires at: 2026-10-01T00:00:00.000Z',
        '        health: needs_reauth',
        '        reconnect required: yes',
      ]);
      expect(allOut).toContain('        last refresh failure kind: invalid_grant');
      expect(allOut).toContain('      github/work: connected');
      expect(allOut.some((line) => line.endsWith(': not connected'))).toBe(true);
      expect(requestedServiceIds).toContain('openai-codex');

      vi.resetModules();
      const { handleConnectCommand: handleFresh } = await import('./connect');
      const filtered = captureConsole();
      try {
        await handleFresh(['status', '--profile', 'alt']);
      } finally {
        filtered.restore();
      }
      const filteredOut = filtered.out();
      expect(filteredOut).toContain('      openai-codex/alt: connected');
      expect(filteredOut.some((line) => line.includes('/work'))).toBe(false);
      expect(filteredOut.some((line) => line.endsWith('GitHub: no profile alt'))).toBe(true);
      expect(filteredOut.some((line) => line.endsWith(': not connected'))).toBe(false);
    } finally {
      restoreAxios();
      await app.close();
    }
  }, CONNECT_IMPORT_TIMEOUT_MS);
});
