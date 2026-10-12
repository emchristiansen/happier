import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCodexSharedAppServer } from './createCodexSharedAppServer';
import { buildCodexAppServerConfigOverrides } from './buildCodexAppServerConfigOverrides';

// Genuine OS enumeration failure; native spawn, socket startup, and cleanup remain real.
const enumeration = vi.hoisted(() => ({ denied: false }));
vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { default: () => enumeration.denied
    ? Promise.reject(new Error('process listing unavailable')) : actual.default() };
});

describe('createCodexSharedAppServer', () => {
  it('preserves native startup failure alongside failed process cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-codex-startup-failure-'));
    enumeration.denied = true;
    try {
      // An actual executable rejects the agent argv before opening a socket. No fake prompt
      // or AppServer logic: this is the native process failure boundary.
      const failure = await createCodexSharedAppServer({
        directory,
        processEnv: { ...process.env, HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
        dependencies: { createRuntimeDirectory: () => mkdtemp(join(directory, 'runtime-')) },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: 'AggregateError',
        errors: [expect.objectContaining({ message: expect.stringContaining('exited before its socket was ready') }),
          expect.objectContaining({ code: 'process_tree_termination_incomplete' })],
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      enumeration.denied = false;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('owns one socket app-server and gives Happier clients WebSocket transports to that server', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new EventEmitter() });
    const spawnProcess = vi.fn(() => child as never);
    const createClient = vi.fn(async (params: unknown) => ({ params, dispose: vi.fn() }));
    const terminateProcess = vi.fn(async () => undefined);
    const removeRuntimeDirectory = vi.fn(async () => undefined);
    const waitForSocket = vi.fn(async () => undefined);

    const server = await createCodexSharedAppServer({
      directory: '/workspace',
      processEnv: {
        HOME: '/home/test',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
      },
      configOverrides: buildCodexAppServerConfigOverrides({}, {
        codexArgs: ['-c', 'model="gpt-5"', '--config=model_reasoning_effort=low'],
      }),
      dependencies: {
        createRuntimeDirectory: async () => '/tmp/happier-codex-private',
        resolveInvocation: async ({ args }) => ({ command: '/usr/bin/codex', args }),
        spawnProcess,
        waitForSocket,
        createClient: createClient as never,
        terminateProcess,
        removeRuntimeDirectory,
      },
    });

    expect(server.endpoint).toBe('unix:///tmp/happier-codex-private/private/app-server.sock');
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/codex',
      [
        'app-server', '--listen', 'unix:///tmp/happier-codex-private/private/app-server.sock',
        '-c', 'model="gpt-5"',
        '-c', 'model_reasoning_effort=low',
      ],
      expect.objectContaining({ cwd: '/workspace', stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    expect(waitForSocket).toHaveBeenCalledWith(
      '/tmp/happier-codex-private/private/app-server.sock',
      child,
      90_000,
    );

    await server.createClient();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace',
      transport: { kind: 'unixWebSocket', socketPath: '/tmp/happier-codex-private/private/app-server.sock' },
    }));

    await server.dispose();
    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(removeRuntimeDirectory).toHaveBeenCalledWith('/tmp/happier-codex-private');
  });
});
