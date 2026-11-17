import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import * as fs from 'node:fs';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

// Descriptor credential mode: credentials arrive on an inherited descriptor and a pairing's credentials leave on one,
// so a caller that keeps them in a secret manager never creates, reads or clears a native access.key.
const envKeys = [
  'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL',
  'HAPPIER_TERMINAL_PAIRING_REQUIRE', 'HAPPIER_CREDENTIALS_FD', 'HAPPIER_CREDENTIALS_SINK_FD', 'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SESSION_AUTOSTART_DAEMON', 'DEBUG',
] as const;
const envScope = createEnvKeyScope(envKeys);
const tokenForAccount = (account: string) => `header.${Buffer.from(JSON.stringify({ sub: account })).toString('base64url')}.sig`;

afterEach(() => {
  envScope.restore();
  vi.doUnmock('node:fs');
  vi.doUnmock('child_process');
  vi.restoreAllMocks();
  vi.resetModules();
});

function startIn(home: string): void {
  envScope.patch({
    HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://a.test', HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: 'https://a.test',
    HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_CREDENTIALS_FD: undefined, HAPPIER_CREDENTIALS_SINK_FD: undefined, DEBUG: undefined,
  });
  vi.resetModules();
}

function sourceDescriptor(home: string, content: string): number {
  const path = join(home, `source-${Math.random().toString(16).slice(2)}`);
  writeFileSync(path, content);
  const fd = openSync(path, 'r');
  envScope.patch({ HAPPIER_CREDENTIALS_FD: String(fd) });
  return fd;
}

const isOpen = (fd: number) => { try { fstatSync(fd); return true; } catch { return false; } };

describe('credential descriptors', () => {
  it('reads the active credentials from HAPPIER_CREDENTIALS_FD and never touches access.key', async () => {
    await withTempDir('happier-cred-fd-', async (home) => {
      envScope.patch({ HAPPIER_HOME_DIR: home });
      vi.resetModules();
      const nativePersistence = await import('@/persistence');
      await nativePersistence.writeCredentialsLegacy({ secret: new Uint8Array(32).fill(2), token: tokenForAccount('native') });
      const { configuration: nativeConfiguration } = await import('@/configuration');
      const nativeBefore = readFileSync(nativeConfiguration.privateKeyFile, 'utf8');

      const sourcePath = join(home, 'source.json');
      const secret = new Uint8Array(32).fill(7);
      writeFileSync(sourcePath, JSON.stringify({ secret: Buffer.from(secret).toString('base64'), token: tokenForAccount('descriptor') }));
      const fd = openSync(sourcePath, 'r');
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_CREDENTIALS_FD: String(fd) });
      vi.resetModules();
      const persistence = await import('@/persistence');

      expect(await persistence.readCredentials()).toEqual({ token: tokenForAccount('descriptor'), encryption: { type: 'legacy', secret } });
      await expect(persistence.writeCredentialsLegacy({ secret, token: tokenForAccount('descriptor') }))
        .rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_READ_ONLY' });
      await persistence.clearCredentials();
      expect(readFileSync(nativeConfiguration.privateKeyFile, 'utf8')).toBe(nativeBefore);
    });
  });

  it('refuses a descriptor below 3', async () => {
    await withTempDir('happier-cred-fd-invalid-', async (home) => {
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_CREDENTIALS_FD: '2' });
      vi.resetModules();
      const persistence = await import('@/persistence');
      await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_INVALID' });
    });
  });

  it('auth wait sends paired credentials only to HAPPIER_CREDENTIALS_SINK_FD and omits the token from its result', async () => {
    await withTempDir('happier-cred-sink-', async (home) => {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_TERMINAL_PAIRING_REQUIRE: 'v3',
      });
      vi.resetModules();
      const app = fastify({ logger: false });
      app.post('/v1/auth/request', async () => ({ state: 'requested' }));
      app.get('/v1/auth/request/status', async () => ({ status: 'authorized' }));
      let response = '';
      const token = tokenForAccount('account-sink');
      app.post('/v1/auth/request/claim', async () => ({ state: 'authorized', token, response }));
      await app.ready();
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
      const sinkPath = join(home, 'sink.json');
      try {
        const { handleAuthRequest } = await import('./auth/request');
        const requestOut = captureConsoleLogAndMuteStdout();
        let request: { publicKey: string; pairing: { secretB64Url: string; createdAtMs: number; expiresAtMs: number } };
        try {
          await handleAuthRequest(['--json']);
          request = JSON.parse(requestOut.logs[0] ?? '');
        } finally {
          requestOut.restore();
        }
        response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
          terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
          pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'),
          createdAtMs: request.pairing.createdAtMs,
          expiresAtMs: request.pairing.expiresAtMs,
          randomBytes: (length) => new Uint8Array(length).fill(length),
        })).toString('base64');

        const sink = openSync(sinkPath, 'w');
        envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
        vi.resetModules();
        const { configuration } = await import('@/configuration');
        const { handleAuthWait } = await import('./auth/wait');
        const waitOut = captureConsoleLogAndMuteStdout();
        let result: Record<string, unknown>;
        try {
          await handleAuthWait(['--json', '--public-key', request.publicKey]);
          result = JSON.parse(waitOut.logs[0] ?? '');
        } finally {
          waitOut.restore();
        }
        expect(result).toMatchObject({ success: true, encryptionType: 'tokenOnly', pairingAuthentication: 'v3', machineId: expect.any(String) });
        expect(result).not.toHaveProperty('token');
        expect(JSON.parse(readFileSync(sinkPath, 'utf8'))).toEqual({ token, encryption: null });
        expect(existsSync(configuration.privateKeyFile)).toBe(false);
        expect(() => closeSync(sink)).toThrow();
      } finally {
        restoreAxios();
        await app.close();
      }
    });
  });

  // C1-FD-01: the source is consumed exactly once; a failed read is terminal and never acquires a reused descriptor number.
  it.each([['malformed', 'not-json'], ['empty', ''], ['schema', JSON.stringify({ token: 5 })]])(
    'a %s source read fails once and later reads never touch the reused descriptor number',
    async (_label, content) => {
      await withTempDir('happier-cred-fd-terminal-', async (home) => {
        startIn(home);
        const fd = sourceDescriptor(home, content);
        const persistence = await import('@/persistence');
        await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_MALFORMED' });
        const unrelated = join(home, 'unrelated.json');
        writeFileSync(unrelated, JSON.stringify({ token: tokenForAccount('unrelated'), encryption: null }));
        const reused = openSync(unrelated, 'r');
        expect(reused).toBe(fd);
        await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_MALFORMED' });
        expect(isOpen(reused)).toBe(true);
        closeSync(reused);
      });
    },
  );

  // C1-FD-02: malformed secret input fails usefully through the real auth command catcher without echoing its bytes.
  it.each([[undefined], ['1']])('auth status reports a malformed source without its content (DEBUG=%s)', async (debug) => {
    await withTempDir('happier-cred-fd-no-echo-', async (home) => {
      startIn(home);
      envScope.patch({ DEBUG: debug });
      sourceDescriptor(home, 'C1SECRET');
      const out: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { out.push(args.map((a) => inspect(a, { depth: 5 })).join(' ')); });
      vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('TEST_EXIT'); }) as never);
      const { handleAuthCliCommand } = await import('@/cli/commands/auth');
      await expect(handleAuthCliCommand({ args: ['auth', 'status', '--json'] } as never)).rejects.toThrow('TEST_EXIT');
      const text = out.join('\n');
      expect(text).toContain('HAPPIER_CREDENTIALS_FD');
      expect(text).not.toContain('C1SECRET');
      expect(text).not.toContain('C1SEC');
    });
  });

  // C1-FD-03: consumed credentials stay bound to the server they were consumed for.
  it('refuses source credentials after real server selection moves to another server, without consuming on nonactive reads', async () => {
    await withTempDir('happier-cred-fd-scope-', async (home) => {
      startIn(home);
      const fd = sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('A'), encryption: null }));
      const persistence = await import('@/persistence');
      expect(await persistence.readCredentials({ serverId: 'other' })).toBeNull();
      expect(isOpen(fd)).toBe(true);
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
      const { applyServerSelectionFromArgs } = await import('@/server/serverSelection');
      await applyServerSelectionFromArgs(['--server-url', 'https://b.test', '--no-persist']);
      expect((await import('@/configuration')).configuration.apiServerUrl).toBe('https://b.test');
      await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SCOPE' });
    });
  });

  it('refuses sink-written credentials after real server selection moves to another server', async () => {
    await withTempDir('happier-cred-sink-scope-', async (home) => {
      startIn(home);
      const sink = openSync(join(home, 'sink.json'), 'w');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') });
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
      const { applyServerSelectionFromArgs } = await import('@/server/serverSelection');
      await applyServerSelectionFromArgs(['--server-url', 'https://b.test', '--no-persist']);
      await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SCOPE' });
    });
  });

  // C1-FD-04: descriptor mode neither copies nor reads native credentials, even when a native incumbent exists.
  it('real server selection does not copy an incumbent native access.key in descriptor mode', async () => {
    await withTempDir('happier-cred-fd-native-copy-', async (home) => {
      startIn(home);
      const { deriveServerIdFromUrl } = await import('@/server/serverId');
      const url = 'https://native-copy.test';
      const dir = join(home, 'servers', deriveServerIdFromUrl(url));
      mkdirSync(dir, { recursive: true });
      const incumbent = JSON.stringify({ token: tokenForAccount('native'), encryption: null });
      writeFileSync(join(dir, 'access.key'), incumbent);
      const settingsPersistence = await import('@/persistence');
      await settingsPersistence.updateSettings((s) => ({ ...s, servers: { ...s.servers, named: { id: 'named', name: 'named', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
      sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('descriptor'), encryption: null }));
      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('@/server/serverSelection');
      await applyServerSelectionFromArgs(['--server', 'named']);
      expect(existsSync(join(home, 'servers', 'named', 'access.key'))).toBe(false);
      expect(readFileSync(join(dir, 'access.key'), 'utf8')).toBe(incumbent);
    });
  });

  it('daemon status discovery reports descriptor identity for the active server and reads no native credential', async () => {
    await withTempDir('happier-cred-fd-status-', async (home) => {
      startIn(home);
      const settingsPersistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      const nativeServer = 'nativeonly';
      await settingsPersistence.updateSettings((s) => ({ ...s, servers: { ...s.servers, [nativeServer]: { id: nativeServer, name: nativeServer, serverUrl: 'https://native.test', webappUrl: 'https://native.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
      mkdirSync(join(home, 'servers', nativeServer), { recursive: true });
      writeFileSync(join(home, 'servers', nativeServer, 'access.key'), JSON.stringify({ token: tokenForAccount('native'), encryption: null }));
      mkdirSync(configuration.activeServerDir, { recursive: true });
      writeFileSync(configuration.privateKeyFile, JSON.stringify({ token: tokenForAccount('native-active'), encryption: null }));
      sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('descriptor'), encryption: null }));
      vi.resetModules();
      const { listDaemonStatusesForAllKnownServers } = await import('@/daemon/multiDaemon');
      const active = (await import('@/configuration')).configuration.activeServerId;
      const statuses = await listDaemonStatusesForAllKnownServers();
      const byId = new Map(statuses.map((entry) => [entry.serverId, entry.auth]));
      expect(byId.get(active)?.accountId).toBe('descriptor');
      expect(byId.get(nativeServer)?.authenticated).toBe(false);
    });
  });

  // C1-FD-05: the one-shot sink is closed on success and on failure; a failed transfer is not cached and not retried.
  it('closes a sink that fails before its first byte and leaves no credentials behind', async () => {
    await withTempDir('happier-cred-sink-ebadf-', async (home) => {
      startIn(home);
      writeFileSync(join(home, 'readonly'), 'incumbent');
      const sink = openSync(join(home, 'readonly'), 'r');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const persistence = await import('@/persistence');
      await expect(persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_SINK_WRITE_FAILED' });
      expect(isOpen(sink)).toBe(false);
      await expect(persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_SINK_USED' });
      expect(await persistence.readCredentials()).toBeNull();
    });
  });

  it('closes a sink after a partial write fails and does not claim or retry the transfer', async () => {
    await withTempDir('happier-cred-sink-partial-', async (home) => {
      startIn(home);
      const path = join(home, 'sink');
      const sink = openSync(path, 'w');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const realWrite = fs.writeSync;
      let calls = 0;
      // OS boundary: the first write is a real 7-byte short write, the next one fails like a broken device.
      vi.doMock('node:fs', async () => ({
        ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
        writeSync: (n: number, b: Buffer, o: number, l: number) => {
          calls += 1;
          if (calls === 1) return realWrite(n, b, o, Math.min(l, 7));
          throw Object.assign(new Error('injected OS write failure'), { code: 'EIO' });
        },
      }));
      const persistence = await import('@/persistence');
      await expect(persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_SINK_WRITE_FAILED' });
      expect(isOpen(sink)).toBe(false);
      expect(readFileSync(path, 'utf8').length).toBe(7);
      expect(calls).toBe(2);
      expect(await persistence.readCredentials()).toBeNull();
    });
  });

  it('reassembles successful short sink writes and closes the sink', async () => {
    await withTempDir('happier-cred-sink-short-', async (home) => {
      startIn(home);
      const path = join(home, 'sink');
      const sink = openSync(path, 'w');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const realWrite = fs.writeSync;
      vi.doMock('node:fs', async () => ({
        ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
        writeSync: (n: number, b: Buffer, o: number, l: number) => realWrite(n, b, o, Math.min(l, 7)),
      }));
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ token: tokenForAccount('A'), encryption: null });
      expect(isOpen(sink)).toBe(false);
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
    });
  });

  // C1-FD-06: descriptor credentials are single-process: no child inherits the numbers and no daemon is started.
  it('does not forward descriptor variables to children and refuses daemon autostart and launch before spawning', async () => {
    await withTempDir('happier-cred-fd-single-process-', async (home) => {
      startIn(home);
      sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('A'), encryption: null }));
      envScope.patch({ HAPPIER_SESSION_AUTOSTART_DAEMON: '1' });
      const spawn = vi.fn();
      vi.doMock('child_process', async () => ({ ...(await vi.importActual<typeof import('child_process')>('child_process')), spawn }));
      const persistence = await import('@/persistence');
      expect(process.env.HAPPIER_CREDENTIALS_FD).toBeUndefined();
      expect(persistence.usesCredentialDescriptors()).toBe(true);
      const { shouldAutoStartDaemonAfterAuth } = await import('@/daemon/ensureDaemon');
      expect(shouldAutoStartDaemonAfterAuth({ env: process.env, isDaemonProcess: false, startedBy: 'terminal' })).toBe(false);
      const { spawnDetachedDaemonStartSync } = await import('@/daemon/runtime/spawnDetachedDaemonStartSync');
      await expect(spawnDetachedDaemonStartSync()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SINGLE_PROCESS' });
      const { startDaemon } = await import('@/daemon/startDaemon');
      await expect(startDaemon()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SINGLE_PROCESS' });
      expect(spawn).not.toHaveBeenCalled();
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
    });
  });

  // C1-FD-07: source and sink each own a different inherited resource; a number is used only while it still names it.
  it.each([['the same number', false], ['duplicated numbers', true]])('refuses source and sink naming one resource through %s before any use', async (_label, duplicate) => {
    await withTempDir('happier-cred-fd-alias-', async (home) => {
      startIn(home);
      const path = join(home, 'shared.json');
      const content = JSON.stringify({ token: tokenForAccount('A'), encryption: null });
      writeFileSync(path, content);
      const fd = openSync(path, 'r+');
      const other = duplicate ? openSync(path, 'r+') : fd;
      envScope.patch({ HAPPIER_CREDENTIALS_FD: String(fd), HAPPIER_CREDENTIALS_SINK_FD: String(other) });
      const persistence = await import('@/persistence');
      await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_INVALID' });
      await expect(persistence.writeCredentialsTokenOnly({ token: tokenForAccount('B') })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_INVALID' });
      expect(isOpen(fd) && isOpen(other)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(content);
      closeSync(fd);
      if (duplicate) closeSync(other);
    });
  });

  it('never writes to an unrelated resource that reuses the sink number', async () => {
    await withTempDir('happier-cred-sink-reuse-', async (home) => {
      startIn(home);
      const sink = openSync(join(home, 'sink.json'), 'w');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const persistence = await import('@/persistence');
      closeSync(sink);
      const unrelatedPath = join(home, 'unrelated.log');
      const unrelated = openSync(unrelatedPath, 'w');
      expect(unrelated).toBe(sink);
      await expect(persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_SINK_WRITE_FAILED' });
      expect(isOpen(unrelated)).toBe(true);
      expect(readFileSync(unrelatedPath, 'utf8')).toBe('');
      closeSync(unrelated);
    });
  });

  it('never reads an unrelated resource that reuses the source number before the first read', async () => {
    await withTempDir('happier-cred-source-reuse-', async (home) => {
      startIn(home);
      const fd = sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('A'), encryption: null }));
      const persistence = await import('@/persistence');
      closeSync(fd);
      const unrelatedPath = join(home, 'unrelated.json');
      writeFileSync(unrelatedPath, JSON.stringify({ token: tokenForAccount('unrelated'), encryption: null }));
      const unrelated = openSync(unrelatedPath, 'r');
      expect(unrelated).toBe(fd);
      await expect(persistence.readCredentials()).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_UNREADABLE' });
      expect(isOpen(unrelated)).toBe(true);
      closeSync(unrelated);
    });
  });

  it('uses distinct source and sink descriptors in their own roles', async () => {
    await withTempDir('happier-cred-fd-distinct-', async (home) => {
      startIn(home);
      const source = sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('A'), encryption: null }));
      const sinkPath = join(home, 'sink.json');
      const sink = openSync(sinkPath, 'w');
      envScope.patch({ HAPPIER_CREDENTIALS_SINK_FD: String(sink) });
      const persistence = await import('@/persistence');
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
      await persistence.writeCredentialsTokenOnly({ token: tokenForAccount('A') });
      expect(JSON.parse(readFileSync(sinkPath, 'utf8'))).toEqual({ token: tokenForAccount('A'), encryption: null });
      expect(isOpen(source) || isOpen(sink)).toBe(false);
    });
  });

  // C1-FD-06 (R3): the server follow-up self-launch and every other Happier self-launch builder refuse before spawning.
  it('refuses the real server follow-up daemon launch and Happier launch specs before spawning', async () => {
    await withTempDir('happier-cred-fd-self-launch-', async (home) => {
      startIn(home);
      sourceDescriptor(home, JSON.stringify({ token: tokenForAccount('A'), encryption: null }));
      const spawn = vi.fn();
      vi.doMock('child_process', async () => ({ ...(await vi.importActual<typeof import('child_process')>('child_process')), spawn }));
      const persistence = await import('@/persistence');
      expect((await persistence.readCredentials())?.token).toBe(tokenForAccount('A'));
      const { runCliAction } = await import('@/cli/commands/server/commandUtilities');
      await expect(runCliAction(['daemon', 'start'])).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SINGLE_PROCESS' });
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      expect(() => buildHappyCliSubprocessLaunchSpec(['tools'])).toThrow(expect.objectContaining({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SINGLE_PROCESS' }));
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it('still launches the server follow-up in native mode', async () => {
    await withTempDir('happier-cred-native-self-launch-', async (home) => {
      startIn(home);
      const { EventEmitter } = await import('node:events');
      const spawn = vi.fn(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 0));
        return child;
      });
      vi.doMock('child_process', async () => ({ ...(await vi.importActual<typeof import('child_process')>('child_process')), spawn }));
      const { runCliAction } = await import('@/cli/commands/server/commandUtilities');
      await runCliAction(['daemon', 'start']);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});
