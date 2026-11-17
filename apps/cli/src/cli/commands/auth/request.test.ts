import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { readFile } from 'node:fs/promises';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
const envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  vi.resetModules();
});

describe('auth request compatibility', () => {
  it('preserves relay expiry and negotiates token-only pairing through legacy-compatible JSON requests', async () => {
    await withTempDir('happier-compatible-token-only-', async (home) => {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const app = fastify({ logger: false });
      const expiresAt = Date.now() + 120_000;
      const requestBodies: unknown[] = [];
      app.post('/v1/auth/request', async (req, reply) => {
        requestBodies.push(req.body);
        if (requestBodies.length === 1) return reply.code(400).send({ error: 'unknown_fields' });
        return { state: 'requested', expiresAt };
      });
      await app.ready();
      const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
      const output = captureConsoleLogAndMuteStdout();
      try {
        const { handleAuthRequest } = await import('./request');
        try {
          await handleAuthRequest(['--json']);
        } catch (error) {
          expect(requestBodies).toEqual([
            expect.objectContaining({ supportsV2: true, supportsTokenOnly: true }),
          ]);
          expect(error).toMatchObject({ response: { data: { error: 'unknown_fields' } } });
          throw error;
        }
        const request = JSON.parse(output.logs[0] ?? '');
        expect(requestBodies).toEqual([
          expect.objectContaining({ publicKey: request.publicKey, supportsV2: true, supportsTokenOnly: true }),
          { publicKey: request.publicKey },
        ]);
        expect(request).toMatchObject({
          expiresAtMs: expiresAt,
          pairing: { expiresAtMs: expiresAt },
        });
        expect(JSON.parse(await readFile(request.stateFile, 'utf8'))).toMatchObject({ pairingExpiresAtMs: expiresAt });
      } finally {
        output.restore();
        restoreAxios();
        await app.close();
      }
    });
  });
});

describe('auth request durability', () => {
  const env = (home: string) => ({
    HAPPIER_HOME_DIR: home,
    HAPPIER_SERVER_URL: 'http://happier-auth.test',
    HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
    HAPPIER_WEBAPP_URL: 'http://webapp.test',
  });

  async function pendingFiles(home: string): Promise<{ dir: string; names: string[] }> {
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(home, 'servers');
    const servers = await readdir(dir);
    expect(servers).toHaveLength(1);
    const pending = join(dir, servers[0]!, 'auth', 'pending');
    return { dir: pending, names: (await readdir(pending)).sort() };
  }

  async function run(
    home: string,
    handler: (body: any, pending: () => Promise<{ dir: string; names: string[] }>) => Promise<unknown>,
  ): Promise<{ result: unknown; error: unknown; bodies: any[]; logs: string[] }> {
    envScope.patch(env(home));
    vi.resetModules();
    const app = fastify({ logger: false });
    const bodies: any[] = [];
    app.post('/v1/auth/request', async (req) => {
      bodies.push(req.body);
      return handler(req.body, () => pendingFiles(home));
    });
    await app.ready();
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
    const output = captureConsoleLogAndMuteStdout();
    try {
      const { handleAuthRequest } = await import('./request');
      try {
        return { result: await handleAuthRequest(['--json']), error: null, bodies, logs: output.logs };
      } catch (error) {
        return { result: null, error, bodies, logs: output.logs };
      }
    } finally {
      output.restore();
      restoreAxios();
      await app.close();
    }
  }

  async function readJson(path: string): Promise<any> {
    return JSON.parse(await readFile(path, 'utf8'));
  }

  it('has the pending state and a public occurrence record on disk, 0600, before the server sees the request', async () => {
    await withTempDir('happier-request-durable-', async (home) => {
      const { stat } = await import('node:fs/promises');
      const { join } = await import('node:path');
      let seenAtPost: { dir: string; names: string[] } | null = null;
      const expiresAt = Date.now() + 60_000;
      const { error, bodies, logs } = await run(home, async (_body, pending) => {
        seenAtPost = await pending();
        return { state: 'requested', expiresAt };
      });
      expect(error).toBeNull();
      expect(bodies).toHaveLength(1);
      const printed = JSON.parse(logs[0] ?? '');
      expect(seenAtPost).not.toBeNull();
      const atPost = seenAtPost as unknown as { dir: string; names: string[] };
      const stateName = printed.stateFile.split('/').pop();
      const occurrenceName = stateName.replace(/\.json$/, '.request.json');
      expect(atPost.names).toEqual([stateName, occurrenceName].sort());
      for (const name of atPost.names) {
        expect((await stat(join(atPost.dir, name))).mode & 0o777).toBe(0o600);
      }
      const state = await readJson(printed.stateFile);
      const occurrence = await readJson(printed.occurrenceFile);
      expect(occurrence).toEqual({
        publicKey: bodies[0].publicKey,
        publicKeyB64Url: printed.publicKeyB64Url,
        serverId: printed.serverId,
        serverUrl: printed.serverUrl,
        stateFile: stateName,
        createdAt: state.createdAt,
      });
      const occurrenceText = await readFile(printed.occurrenceFile, 'utf8');
      for (const secret of [state.secretKey, state.claimSecret, state.pairingSecret]) {
        expect(occurrenceText.includes(secret)).toBe(false);
      }
      // The server's expiry is folded into the state after the response.
      expect(state.pairingExpiresAtMs).toBe(expiresAt);
      // No temporary file is left behind.
      expect((await pendingFiles(home)).names).toEqual([stateName, occurrenceName].sort());
    });
  });

  it('keeps the state and the public record when the response is lost, and says the outcome is unknown', async () => {
    await withTempDir('happier-request-lost-', async (home) => {
      const { join } = await import('node:path');
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
      try {
        const { error, bodies } = await run(home, async () => {
          throw Object.assign(new Error('synthetic lost response'), { statusCode: 503 });
        });
        expect(error).not.toBeNull();
        expect(bodies).toHaveLength(1);
        const { dir, names } = await pendingFiles(home);
        expect(names).toHaveLength(2);
        const occurrenceName = names.find((name) => name.endsWith('.request.json'))!;
        const occurrence = await readJson(join(dir, occurrenceName));
        expect(occurrence.publicKey).toBe(bodies[0].publicKey);
        const state = await readJson(join(dir, occurrence.stateFile));
        expect(state.publicKey).toBe(bodies[0].publicKey);
        expect(typeof state.secretKey).toBe('string');
        expect(errors.some((line) => line.includes('outcome unknown') && line.includes(occurrenceName))).toBe(true);
        for (const secret of [state.secretKey, state.claimSecret, state.pairingSecret]) {
          expect(errors.join('\n').includes(secret)).toBe(false);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('sends nothing when the pending state cannot be persisted', async () => {
    await withTempDir('happier-request-unpersistable-', async (home) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      envScope.patch(env(home));
      vi.resetModules();
      const { configuration } = await import('@/configuration');
      await mkdir(join(configuration.activeServerDir, 'auth'), { recursive: true });
      await writeFile(join(configuration.activeServerDir, 'auth', 'pending'), 'not a directory');
      const { error, bodies } = await run(home, async () => ({ state: 'requested' }));
      expect(error).not.toBeNull();
      expect(bodies).toHaveLength(0);
    });
  });

  it('keeps the earlier valid state when the post-response update cannot be written', async () => {
    await withTempDir('happier-request-update-fails-', async (home) => {
      const { chmod } = await import('node:fs/promises');
      const { join } = await import('node:path');
      let pendingDir = '';
      const { error, bodies } = await run(home, async (_body, pending) => {
        pendingDir = (await pending()).dir;
        await chmod(pendingDir, 0o500);
        return { state: 'requested', expiresAt: Date.now() + 1_000 };
      });
      await chmod(pendingDir, 0o700);
      expect(error).not.toBeNull();
      expect(bodies).toHaveLength(1);
      const { names } = await pendingFiles(home);
      expect(names).toHaveLength(2);
      const occurrence = await readJson(join(pendingDir, names.find((name) => name.endsWith('.request.json'))!));
      const state = await readJson(join(pendingDir, occurrence.stateFile));
      expect(state.publicKey).toBe(bodies[0].publicKey);
      // The pre-request state: the local pairing expiry, which `auth wait` accepts.
      expect(state.pairingExpiresAtMs).toBeGreaterThan(state.pairingCreatedAtMs);
    });
  });
});
