import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const executable = vi.hoisted(() => ({ socketPath: '', spawn: vi.fn() }));

// Executable discovery/inventory and foreground process creation are external OS boundaries.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_binary: string, args: readonly string[]) => ({
      stdout: args[0] === '--version' ? 'herdr 0.9.2'
        : JSON.stringify({ sessions: [{ name: 'default', socket_path: executable.socketPath, running: true }] }),
      stderr: '',
    }),
  }),
  spawn: executable.spawn,
}));

import { handleHerdrCliCommand } from './herdr';

const envScope = createEnvKeyScope(['HERDR_ENV', 'HERDR_SOCKET_PATH']);
const context = { args: ['herdr'], rawArgv: [], terminalRuntime: null };

beforeEach(() => {
  envScope.patch({ HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined });
  executable.spawn.mockReset();
  executable.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
});

afterEach(() => envScope.restore());

describe('happier herdr server admission', () => {
  it('refuses an older running server before opening its TUI', async () => {
    await withHerdrApi(async (api) => {
      executable.socketPath = api.socketPath;
      await expect(handleHerdrCliCommand(context)).rejects.toMatchObject({ code: 'unsupported_server_version' });
      expect(executable.spawn).not.toHaveBeenCalled();
    }, { serverVersion: '0.9.1' });
  });

  it('opens the admitted existing server without creating an agent pane', async () => {
    await withHerdrApi(async (api) => {
      executable.socketPath = api.socketPath;
      await handleHerdrCliCommand(context);
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot']);
      expect(executable.spawn).toHaveBeenCalledWith(expect.any(String), [],
        expect.objectContaining({ env: expect.objectContaining({ HERDR_SOCKET_PATH: api.socketPath }) }));
    });
  });
});
