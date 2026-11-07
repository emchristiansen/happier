import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnSpy,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('Claude native import OS cancellation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    spawnSpy.mockReset();
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('carries caller cancellation into an in-flight native keychain read', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-import-abort-'));
    const controller = new AbortController();
    const children: EventEmitter[] = [];
    const readSignals: Array<AbortSignal | undefined> = [];
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(homeDir, '.claude'));
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    spawnSpy.mockImplementation((_command: string, _args: string[], options: { signal?: AbortSignal }) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      children.push(child);
      readSignals.push(options.signal);
      options.signal?.addEventListener('abort', () => child.emit('error', new DOMException('Aborted', 'AbortError')), { once: true });
      return child;
    });
    const { claudeCloudConnect } = await import('./connect');
    const importCredentials = claudeCloudConnect.importCredentials;
    if (!importCredentials) throw new Error('Claude native import is unavailable');
    const pending = importCredentials({ source: 'native', signal: controller.signal });
    const outcome = pending.then(() => null, (error: unknown) => error);
    try {
      expect(readSignals.length).toBeGreaterThan(0);
      expect(readSignals.every((signal) => signal === controller.signal)).toBe(true);
    } finally {
      controller.abort();
      for (const child of children) child.emit('close', 1);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
