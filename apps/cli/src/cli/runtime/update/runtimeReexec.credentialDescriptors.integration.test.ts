import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

// C1-FD-06 (runtime re-exec): with descriptor credentials, normal startup must never hand the command to an installed
// newer runtime, whose child would not have the descriptors and would read the native credential store instead.
// Fixtures are synthetic credentials in disposable homes; the "newer runtime" is a real filesystem install whose entry
// imports the real credential owner and records what it would have used.

const cliRoot = resolve(__dirname, '../../../..');
const repoRoot = resolve(cliRoot, '../..');
const tsxLoader = pathToFileURL(createRequire(join(repoRoot, 'package.json')).resolve('tsx')).href;
const tsxApi = pathToFileURL(join(repoRoot, 'node_modules/tsx/dist/esm/api/index.mjs')).href;
const persistenceSource = join(cliRoot, 'src/persistence.ts');

const scope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_CREDENTIALS_FD', 'HAPPIER_CREDENTIALS_SINK_FD', 'HAPPIER_CLI_RUNTIME_DISABLE', 'HAPPIER_CLI_RUNTIME_REEXEC',
]);
const token = (subject: string) => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig`;
const isOpen = (fd: number) => { try { fs.fstatSync(fd); return true; } catch { return false; } };

function useHome(home: string): void {
  scope.patch({
    HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://a.test', HAPPIER_PUBLIC_SERVER_URL: undefined,
    HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_CREDENTIALS_FD: undefined, HAPPIER_CREDENTIALS_SINK_FD: undefined,
    HAPPIER_CLI_RUNTIME_DISABLE: undefined, HAPPIER_CLI_RUNTIME_REEXEC: undefined,
  });
  vi.resetModules();
}

afterEach(() => { scope.restore(); vi.resetModules(); });

/** Native incumbent credential plus an installed newer runtime whose entry records what credential it would use. */
async function nativeHomeWithNewerRuntime(home: string): Promise<{ receipt: string; accessKey: () => string }> {
  useHome(home);
  const native = await import('@/persistence');
  await native.writeCredentialsTokenOnly({ token: token('native') });
  const { configuration } = await import('@/configuration');
  const accessKeyPath = configuration.privateKeyFile;
  expect(JSON.parse(fs.readFileSync(accessKeyPath, 'utf8')).token).toBe(token('native'));
  const runtime = join(home, 'runtime/node_modules/@happier-dev/cli');
  fs.mkdirSync(join(runtime, 'dist'), { recursive: true });
  fs.writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', version: '999.0.0' }));
  const receipt = join(home, 'runtime-child-receipt.json');
  fs.writeFileSync(join(runtime, 'dist/index.mjs'), [
    `import fs from 'node:fs';`,
    `import { tsImport } from ${JSON.stringify(tsxApi)};`,
    `const p = await tsImport(${JSON.stringify(persistenceSource)}, import.meta.url);`,
    `const credential = await p.readCredentials();`,
    `fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), descriptorMode: p.usesCredentialDescriptors(), token: credential?.token ?? null }));`,
  ].join('\n'));
  return { receipt, accessKey: () => fs.readFileSync(accessKeyPath, 'utf8') };
}

/** Normal `happier` startup (src/index.ts through the repository's tsx loader) with an optional inherited fd 3. */
function startCli(home: string, args: string[], fd3?: number, role?: 'HAPPIER_CREDENTIALS_FD' | 'HAPPIER_CREDENTIALS_SINK_FD') {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://a.test', HAPPIER_CLI_UPDATE_CHECK: '0',
    TSX_TSCONFIG_PATH: join(cliRoot, 'tsconfig.json'),
  };
  for (const key of ['HAPPIER_CREDENTIALS_FD', 'HAPPIER_CREDENTIALS_SINK_FD', 'HAPPIER_CLI_RUNTIME_DISABLE', 'HAPPIER_CLI_RUNTIME_REEXEC', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_PUBLIC_SERVER_URL']) delete env[key];
  if (role) env[role] = '3';
  return spawnSync(process.execPath, ['--import', tsxLoader, join(cliRoot, 'src/index.ts'), ...args], {
    cwd: cliRoot, env, encoding: 'utf8', timeout: 90_000,
    stdio: fd3 === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', fd3],
  });
}

describe('C1-FD-06 runtime re-exec in descriptor mode', () => {
  it('normal startup with a descriptor source refuses before launching the newer runtime', async () => {
    await withTempDir('fd06-startup-source-', async (home) => {
      const { receipt, accessKey } = await nativeHomeWithNewerRuntime(home);
      const before = accessKey();
      const sourcePath = join(home, 'descriptor-source.json');
      fs.writeFileSync(sourcePath, JSON.stringify({ token: token('descriptor'), encryption: null }));
      const fd = fs.openSync(sourcePath, 'r');
      try {
        const run = startCli(home, ['auth', 'status'], fd, 'HAPPIER_CREDENTIALS_FD');
        expect(run.status, run.stderr).toBe(1);
        expect(run.stderr).toContain('Re-executing into the installed newer Happier runtime is not available with HAPPIER_CREDENTIALS_FD');
        expect(fs.existsSync(receipt)).toBe(false);
        expect(accessKey()).toBe(before);
      } finally {
        fs.closeSync(fd);
      }
    });
  }, 120_000);

  it('normal startup with a descriptor sink refuses before launching the newer runtime; nothing is written anywhere', async () => {
    await withTempDir('fd06-startup-sink-', async (home) => {
      const { receipt, accessKey } = await nativeHomeWithNewerRuntime(home);
      const before = accessKey();
      const sinkPath = join(home, 'descriptor-sink.json');
      fs.writeFileSync(sinkPath, '');
      const fd = fs.openSync(sinkPath, 'w');
      try {
        const run = startCli(home, ['auth', 'status'], fd, 'HAPPIER_CREDENTIALS_SINK_FD');
        expect(run.status, run.stderr).toBe(1);
        expect(run.stderr).toContain('Re-executing into the installed newer Happier runtime is not available with HAPPIER_CREDENTIALS_FD/HAPPIER_CREDENTIALS_SINK_FD');
        expect(fs.existsSync(receipt)).toBe(false);
        expect(fs.readFileSync(sinkPath, 'utf8')).toBe('');
        expect(accessKey()).toBe(before);
      } finally {
        fs.closeSync(fd);
      }
    });
  }, 120_000);

  it('native control: normal startup still re-executes into the newer runtime, which reads the native credential', async () => {
    await withTempDir('fd06-startup-native-', async (home) => {
      const { receipt } = await nativeHomeWithNewerRuntime(home);
      const run = startCli(home, ['auth', 'status']);
      expect(run.status, run.stderr).toBe(0);
      const child = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      expect(child).toMatchObject({ argv: ['auth', 'status'], descriptorMode: false, token: token('native') });
      expect(child.pid).not.toBe(process.pid);
    });
  }, 120_000);

  for (const role of ['HAPPIER_CREDENTIALS_FD', 'HAPPIER_CREDENTIALS_SINK_FD'] as const) {
    it(`real maybeReexecToRuntime refuses with ${role} before resolving or launching a runtime; the descriptor stays usable`, async () => {
      await withTempDir('fd06-reexec-', async (home) => {
        const { receipt } = await nativeHomeWithNewerRuntime(home);
        const path = join(home, 'descriptor.json');
        fs.writeFileSync(path, role === 'HAPPIER_CREDENTIALS_FD' ? JSON.stringify({ token: token('descriptor'), encryption: null }) : '');
        const fd = fs.openSync(path, role === 'HAPPIER_CREDENTIALS_FD' ? 'r' : 'w');
        scope.patch({ [role]: String(fd) });
        vi.resetModules();
        const parent = await import('@/persistence');
        expect(parent.usesCredentialDescriptors()).toBe(true);
        const { maybeReexecToRuntime } = await import('@/cli/runtime/update/runtimeReexec');
        const ensureRuntimeExecutable = vi.fn(async () => process.execPath);
        const exit = vi.fn();
        await expect(maybeReexecToRuntime({
          cliRootDir: cliRoot, homeDir: home, packageName: '@happier-dev/cli', argv: ['auth', 'status'], env: process.env,
          ensureRuntimeExecutable, exit: exit as unknown as typeof process.exit,
        })).rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_DESCRIPTOR_SINGLE_PROCESS' });
        expect(ensureRuntimeExecutable).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
        expect(fs.existsSync(receipt)).toBe(false);
        expect(isOpen(fd)).toBe(true);
        if (role === 'HAPPIER_CREDENTIALS_FD') {
          expect((await parent.readCredentials())?.token).toBe(token('descriptor'));
        } else {
          await parent.writeCredentialsTokenOnly({ token: token('paired') });
          expect(JSON.parse(fs.readFileSync(path, 'utf8')).token).toBe(token('paired'));
        }
      });
    }, 60_000);
  }

  it('descriptor mode without a newer runtime is untouched: no refusal, no launch, the source is read in this process', async () => {
    await withTempDir('fd06-no-runtime-', async (home) => {
      useHome(home);
      const path = join(home, 'descriptor.json');
      fs.writeFileSync(path, JSON.stringify({ token: token('descriptor'), encryption: null }));
      const fd = fs.openSync(path, 'r');
      scope.patch({ HAPPIER_CREDENTIALS_FD: String(fd) });
      vi.resetModules();
      const parent = await import('@/persistence');
      const { maybeReexecToRuntime } = await import('@/cli/runtime/update/runtimeReexec');
      const exit = vi.fn();
      await maybeReexecToRuntime({
        cliRootDir: cliRoot, homeDir: home, packageName: '@happier-dev/cli', argv: ['auth', 'status'], env: process.env,
        exit: exit as unknown as typeof process.exit,
      });
      expect(exit).not.toHaveBeenCalled();
      expect((await parent.readCredentials())?.token).toBe(token('descriptor'));
    });
  }, 60_000);
});
