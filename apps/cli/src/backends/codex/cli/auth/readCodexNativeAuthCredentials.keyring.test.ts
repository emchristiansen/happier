import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// OS credential-store commands are the system boundary; token/config parsing stays real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { readCodexNativeAuthCredentials } from './readCodexEnvironmentAuthState';

const native = JSON.stringify({ tokens: {
  id_token: 'native-id', access_token: 'native-access', refresh_token: 'native-refresh', account_id: 'native-account',
} });

describe('Codex native keyring import OS boundary', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    spawnMock.mockReset();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function home() {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-keyring-os-'));
    dirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    return dir;
  }
  function processResult(stdout: string, status: number) {
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.write(stdout);
        child.emit('close', status);
      });
      return child;
    });
  }

  it('reads the exact macOS Codex service/account with no keychain write', async () => {
    processResult(native, 0);
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: await home() }, platform: 'darwin' }))
      .resolves.toMatchObject({ accountId: 'native-account' });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
      '/usr/bin/security', ['find-generic-password', '-s', 'Codex Auth', '-a', expect.stringMatching(/^cli\|[a-f0-9]{16}$/), '-w'],
    ]);
  });

  it('reads the exact Linux Secret Service entry and rejects ambiguous logins', async () => {
    const dir = await home();
    processResult(`[/1]\nlabel = Codex\nsecret = ${native}\ncreated = 2026-01-01 00:00:00\n`, 0);
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir }, platform: 'linux' }))
      .resolves.toMatchObject({ accountId: 'native-account' });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
      'secret-tool', ['search', '--all', '--unlock', 'service', 'Codex Auth', 'username', expect.stringMatching(/^cli\|[a-f0-9]{16}$/), 'target', 'default'],
    ]);
    processResult(`[/1]\nsecret = ${native}\n[/2]\nsecret = ${native}\n`, 0);
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir }, platform: 'linux' }))
      .rejects.toMatchObject({ code: 'credentials_unavailable' });
  });

  it('returns a safe unavailable result for denied or missing OS access', async () => {
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => child.emit('error', new Error('private-path /private/token secret-value')));
      return child;
    });
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: await home() }, platform: 'darwin' }))
      .rejects.toMatchObject({ code: 'credentials_unavailable', message: 'Codex native credentials are unavailable' });
  });

  it('cancels an in-flight OS read without exposing the caller abort reason', async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => controller.abort(new Error('private-secret')));
      return child;
    });
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: await home() }, platform: 'darwin', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Credential import cancelled' });
    expect(child.kill).toHaveBeenCalled();
  });
});
