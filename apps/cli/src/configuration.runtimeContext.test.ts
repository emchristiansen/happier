import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { HAPPIER_RUNTIME_CONTEXT_ENV_KEYS } from '@/utils/env/resolveHappierRuntimeContextEnv';

const envScope = createEnvKeyScope(HAPPIER_RUNTIME_CONTEXT_ENV_KEYS);
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  envScope.restore();
  vi.resetModules();
});

describe('configuration runtime-context bootstrap', () => {
  it.each([
    ['Node source', ['node', '/repo/apps/cli/src/index.ts']],
    ['compiled Bun', ['/runtime/hdev', '/$bunfs/root/index.mjs']],
    ['packaged wrapper', ['bun', '/runtime/wrapper.mjs', '/runtime/cli/package-dist/index.mjs']],
  ] as const)('restores the real managed argv scope before configuration loads (%s)', async (_runtime, entrypoint) => {
    await withTempDir('happier-runtime-context-', async (tempDir) => {
      const homeDir = join(tempDir, "selected user's 日本語 home");
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'selected-profile',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'selected-daemon',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:43101',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:43101',
        HAPPIER_PUBLIC_SERVER_URL: 'https://selected.example.test',
        HAPPIER_WEBAPP_URL: 'https://selected-web.example.test',
      });
      process.argv = ['node', '/repo/apps/cli/src/index.ts', 'resume', 'session-sentinel'];
      vi.resetModules();
      const { createHerdrResumeArgv } = await import('./integrations/herdr/bindManagedSession');
      const managedArgv = createHerdrResumeArgv('session-sentinel', 'publicdev');
      expect(managedArgv[0]).toBe('hdev');

      const hostileHome = join(tempDir, 'hostile-home');
      envScope.patch({
        HAPPIER_HOME_DIR: hostileHome,
        HAPPIER_ACTIVE_SERVER_ID: 'hostile-profile',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'hostile-daemon',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:43102',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:43102',
        HAPPIER_PUBLIC_SERVER_URL: 'https://hostile.example.test',
        HAPPIER_WEBAPP_URL: 'https://hostile-web.example.test',
      });
      process.argv = [...entrypoint, ...managedArgv.slice(1)];
      vi.resetModules();
      const { configuration, reloadConfiguration } = await import('./configuration');
      expect(configuration.happyHomeDir).toBe(homeDir);
      expect(configuration.settingsFile).toBe(join(homeDir, 'settings.json'));
      // Assert the credential lookup path without opening or creating credentials.
      expect(configuration.privateKeyFile).toBe(join(homeDir, 'servers', 'selected-profile', 'access.key'));
      expect(configuration.serverUrl).toBe('https://selected.example.test');
      expect(configuration.apiServerUrl).toBe('http://127.0.0.1:43101');
      expect(configuration.webappUrl).toBe('https://selected-web.example.test');
      expect(configuration.daemonStateFile).toContain(join('servers', 'selected-daemon'));
      expect(existsSync(hostileHome)).toBe(false);
      expect(existsSync(configuration.privateKeyFile)).toBe(false);
      const { parseCliArgs } = await import('./cli/parseArgs');
      expect(parseCliArgs(process.argv.slice(2)).args).toEqual(['resume', 'session-sentinel']);

      const { maybeReexecToRuntime } = await import('./cli/runtime/update/runtimeReexec');
      const exec = vi.fn(() => Buffer.alloc(0));
      // Only OS/filesystem/runtime detection boundaries are replaced; startup context stays real.
      await expect(maybeReexecToRuntime({
        cliRootDir: '/repo/apps/cli',
        homeDir: configuration.happyHomeDir,
        publicReleaseRing: 'publicdev',
        packageName: '@happier-dev/cli',
        argv: managedArgv.slice(1),
        env: { ...process.env, HAPPIER_CLI_RUNTIME_DISABLE: '0', HAPPIER_CLI_RUNTIME_REEXEC: '0' },
        exists: () => true,
        readVersion: (path) => path.includes('runtime.dev') ? '9.9.9' : '1.0.0',
        ensureRuntimeExecutable: async () => '/managed/runtime',
        // This OS boundary only exercises the buffer-returning overload used by re-exec.
        exec: exec as unknown as typeof import('node:child_process').execFileSync,
        exit: () => { throw new Error('sentinel-reexec-exit'); },
      })).rejects.toThrow('sentinel-reexec-exit');
      expect(exec).toHaveBeenCalledWith(
        '/managed/runtime',
        [join(homeDir, 'runtime.dev', 'node_modules', '@happier-dev', 'cli', 'dist', 'index.mjs'), ...managedArgv.slice(1)],
        expect.objectContaining({ env: expect.objectContaining({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: 'selected-profile',
          HAPPIER_SERVER_URL: 'http://127.0.0.1:43101',
          HAPPIER_PUBLIC_SERVER_URL: 'https://selected.example.test',
        }) }),
      );

      // A later explicit selection must not be overwritten by reapplying the startup payload.
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'later-profile';
      reloadConfiguration();
      const reloaded = await import('./configuration');
      expect(reloaded.configuration.activeServerId).toBe('later-profile');
    });
  });

  it('clears omitted split endpoints instead of inheriting stale values', async () => {
    await withTempDir('happier-runtime-context-single-', async (tempDir) => {
      const payload = Buffer.from(JSON.stringify({
        HAPPIER_HOME_DIR: join(tempDir, 'selected'),
        HAPPIER_ACTIVE_SERVER_ID: 'single-profile',
        HAPPIER_SERVER_URL: 'https://single.example.test',
        HAPPIER_WEBAPP_URL: 'https://single-web.example.test',
      })).toString('base64url');
      envScope.patch({
        HAPPIER_HOME_DIR: join(tempDir, 'hostile'),
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:43102',
        HAPPIER_PUBLIC_SERVER_URL: 'https://hostile.example.test',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'hostile-daemon',
      });
      process.argv = ['node', '/repo/apps/cli/src/index.ts', '--runtime-context', payload, 'resume', 'session-sentinel'];
      vi.resetModules();
      const { configuration } = await import('./configuration');
      expect(configuration.serverUrl).toBe('https://single.example.test');
      expect(configuration.apiServerUrl).toBe('https://single.example.test');
      expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBeUndefined();
      expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
      expect(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID).toBeUndefined();
    });
  });

  it.each([
    'not-base64url!',
    Buffer.from(JSON.stringify({ PRIVATE_SENTINEL_SECRET: 'private-sentinel-value' })).toString('base64url'),
    Buffer.from(JSON.stringify({ HAPPIER_HOME_DIR: 42 })).toString('base64url'),
  ])('rejects invalid payloads before configuration creates its home', async (payload) => {
    await withTempDir('happier-runtime-context-invalid-', async (tempDir) => {
      const untouchedHome = join(tempDir, 'must-not-be-created');
      envScope.patch({ HAPPIER_HOME_DIR: untouchedHome });
      process.argv = ['node', '/repo/apps/cli/src/index.ts', '--runtime-context', payload, 'resume', 'session-sentinel'];
      vi.resetModules();
      let failure: unknown;
      try {
        await import('./configuration');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/runtime-context/);
      expect(String(failure)).not.toContain(payload);
      expect(String(failure)).not.toContain('private-sentinel-value');
      expect(existsSync(untouchedHome)).toBe(false);
    });
  });
});
