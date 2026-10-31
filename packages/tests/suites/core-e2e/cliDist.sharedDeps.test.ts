import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const CLI_SHARED_DEP_PACKAGE_NAMES = ['agents', 'cli-common', 'protocol', 'release-runtime'] as const;

type RunLoggedCommand = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}) => Promise<void>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

async function writeSharedWorkspaceOutputs(repoRoot: string, protocolMarker = 'protocol-from-workspace'): Promise<void> {
  await createBundledWorkspacePackageDirs(repoRoot);

  const outputEntries = CLI_SHARED_DEP_PACKAGE_NAMES.map((packageName) => ({
    packageName,
    path: resolve(repoRoot, 'packages', packageName, 'dist', 'index.js'),
    contents: packageName === 'protocol' ? `export const marker = '${protocolMarker}';\n` : 'export {};\n',
  }));

  for (const entry of outputEntries) {
    await mkdir(resolve(entry.path, '..'), { recursive: true });
    await writeFile(entry.path, entry.contents, 'utf8');

    const bundledPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', entry.packageName);
    await writeFile(
      resolve(bundledPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: `@happier-dev/${entry.packageName}`,
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await mkdir(resolve(bundledPackageDir, 'dist'), { recursive: true });
    await writeFile(resolve(bundledPackageDir, 'dist', 'index.js'), entry.contents, 'utf8');
  }
}

async function createBundledWorkspacePackageDirs(repoRoot: string): Promise<void> {
  for (const packageName of CLI_SHARED_DEP_PACKAGE_NAMES) {
    await mkdir(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', packageName), { recursive: true });
  }
}

describe('core e2e: cli dist build', () => {
  let dir: string | undefined;
  let extraDir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (extraDir) {
      await rm(extraDir, { recursive: true, force: true });
      extraDir = undefined;
    }
  });

  it('builds shared workspace deps before returning a usable CLI dist entrypoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export {};\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    const { ensureCliDistBuilt } = await import('../../src/testkit/process/cliDist');

    const entrypoint = await ensureCliDistBuilt(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint).toBe(resolve(cliDistDir, 'index.mjs'));
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(await exists(resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'))).toBe(true);
    expect(await exists(resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'))).toBe(true);
  });

  it('J078 creates retained CLI dist generations for spawned processes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export {};\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    const { ensureCliDistSnapshotEntrypoint } = await import('../../src/testkit/process/cliDist');

    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint).not.toBe(resolve(snapshotDir, 'dist', 'index.mjs'));
    expect(await exists(entrypoint)).toBe(true);

    const entrypoint2 = await ensureCliDistSnapshotEntrypoint(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint2).not.toBe(entrypoint);
    expect(await exists(entrypoint)).toBe(true);
  });

  it('launches the CLI dist snapshot from an arbitrary cwd with bundled workspace packages available', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-launch-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await createBundledWorkspacePackageDirs(repoRoot);
    await mkdir(cliDistDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });

    await writeFile(resolve(cliDistDir, 'index.mjs'), "import { marker } from './chunk-hash.mjs'; console.log(marker);\n", 'utf8');
    await writeFile(resolve(cliDistDir, 'chunk-hash.mjs'), "import { marker } from '@happier-dev/protocol'; export { marker };\n", 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir: resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot'),
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    const execution = await execFileAsync(launchSpec.command, launchSpec.args, {
      cwd: arbitraryCwd,
      env: {
        ...process.env,
        ...(launchSpec.env ?? {}),
      },
    });

    expect(execution.stdout.trim()).toBe('protocol-ok');
  });

  it('launches the CLI dist snapshot with hoisted root runtime deps alongside CLI-local bundled packages', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-hoisted-launch-'));
    const repoRoot = dir;
    extraDir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-external-snapshot-'));
    const externalSnapshotRoot = extraDir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const rootAxiosDir = resolve(repoRoot, 'node_modules', 'axios');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await mkdir(cliDistDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(rootAxiosDir, { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });
    await createBundledWorkspacePackageDirs(repoRoot);

    await writeFile(
      resolve(cliDistDir, 'index.mjs'),
      "import axios from 'axios'; import { marker } from './chunk-hash.mjs'; console.log(`${marker}:${axios.hoisted}`);\n",
      'utf8',
    );
    await writeFile(resolve(cliDistDir, 'chunk-hash.mjs'), "import { marker } from '@happier-dev/protocol'; export { marker };\n", 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');
    await writeFile(
      resolve(rootAxiosDir, 'package.json'),
      JSON.stringify({
        name: 'axios',
        main: './index.js',
      }, null, 2),
      'utf8',
    );
    await writeFile(resolve(rootAxiosDir, 'index.js'), "module.exports = { hoisted: 'axios-ok' };\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir: resolve(externalSnapshotRoot, 'cli-dist-snapshot'),
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    const execution = await execFileAsync(launchSpec.command, launchSpec.args, {
      cwd: arbitraryCwd,
      env: {
        ...process.env,
        ...(launchSpec.env ?? {}),
      },
    });

    expect(execution.stdout.trim()).toBe('protocol-ok:axios-ok');
  });

  it('J078 resolves source mode from its returned generation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-source-snapshot-launch-'));
    const repoRoot = dir;

    const cliSrcDir = resolve(repoRoot, 'apps', 'cli', 'src');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await createBundledWorkspacePackageDirs(repoRoot);
    await mkdir(cliSrcDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });

    await writeFile(resolve(cliSrcDir, 'index.ts'), "import { marker } from '@happier-dev/protocol'; console.log(marker);\n", 'utf8');
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');
    await writeFile(resolve(repoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}', 'utf8');
    await writeFile(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(launchSpec.cwd).not.toBe(snapshotDir);
    expect(launchSpec.args).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringContaining('tsx/dist/esm/index.mjs'),
        expect.stringContaining(resolve(launchSpec.cwd!, 'src', 'index.ts')),
      ]),
    );
  });

  it('J078 retries private snapshot copy when dist files change during the first copy attempt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-retry-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export { value } from './copilotCliAuthSpec-hash.mjs';\n", 'utf8');
    await writeFile(resolve(cliDistDir, 'copilotCliAuthSpec-hash.mjs'), "export const value = 1;\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let shouldFailOnce = true;
      return {
        ...actual,
        cp: vi.fn(async (...args: Parameters<typeof actual.cp>) => {
          if (shouldFailOnce) {
            shouldFailOnce = false;
            const error = Object.assign(new Error('simulated dist race'), {
              code: 'ENOENT',
              path: resolve(cliDistDir, 'copilotCliAuthSpec-hash.mjs'),
            });
            throw error;
          }
          return await actual.cp(...args);
        }),
      };
    });

    try {
      const { ensureCliDistSnapshotEntrypoint } = await import('../../src/testkit/process/cliDist');

      const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
      const entrypoint = await ensureCliDistSnapshotEntrypoint(
        { testDir: repoRoot, env: { ...process.env, CI: '1' } },
        {
          repoRoot,
          runCommand,
          snapshotDir,
          lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
        },
      );

      expect(entrypoint).not.toBe(resolve(snapshotDir, 'dist', 'index.mjs'));
      expect(await exists(entrypoint)).toBe(true);
      expect(await exists(resolve(entrypoint, '..', 'copilotCliAuthSpec-hash.mjs'))).toBe(true);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});


// J078: install genuine system boundaries before the real owners load. Fixture cp remains real.
const j078Boundary = await vi.hoisted(async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const req = createRequire(`${process.cwd()}/package.json`);
  const fs = req('node:fs');
  const promises = req('node:fs/promises');
  const cp = req('node:child_process');
  const http = req('node:http');
  const https = req('node:https');
  const net = req('node:net');
  const original = { read: fs.readFileSync, cpSync: fs.cpSync, cp: promises.cp, kill: process.kill, fetch: globalThis.fetch,
    child: Object.fromEntries(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].map((key) => [key, cp[key]])),
    httpRequest: http.request, httpsRequest: https.request, httpServer: http.createServer, netServer: net.createServer };
  const state = { active: true, attempts: [] as string[], onCopy: null as null | ((src: string, dest: string, run: () => Promise<void>) => Promise<void>) };
  const refuse = (name: string) => (..._args: unknown[]) => { state.attempts.push(name); throw new Error(`J078 forbidden external boundary: ${name}`); };
  for (const key of Object.keys(original.child)) cp[key] = (...args: unknown[]) => state.active ? refuse(key)(...args) : original.child[key](...args);
  http.request = (...args: unknown[]) => state.active ? refuse('http')(...args) : original.httpRequest(...args);
  https.request = (...args: unknown[]) => state.active ? refuse('https')(...args) : original.httpsRequest(...args);
  http.createServer = (...args: unknown[]) => state.active ? refuse('server')(...args) : original.httpServer(...args);
  net.createServer = (...args: unknown[]) => state.active ? refuse('net')(...args) : original.netServer(...args);
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => state.active ? refuse('fetch')(...args) : original.fetch(...args)) as typeof fetch;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (!state.active) return original.kill(pid, signal);
    if (signal !== 0) return refuse('signal')(pid, signal);
    return true; // Fixture liveness only; never send signal 0.
  }) as typeof process.kill;
  fs.readFileSync = (...args: unknown[]) => state.active && typeof args[0] === 'string' && /^\/proc\/\d+\/stat$/.test(args[0])
    ? `1 (fixture) S ${Array(18).fill('0').join(' ')} 100` : original.read(...args);
  const allowed = (path: unknown) => {
    const root = process.env.TMPDIR;
    if (!root || typeof path !== 'string' || !(path === root || path.startsWith(`${root}/`))) {
      throw new Error(`J078 fixture copy outside owned TMPDIR: ${String(path)}`);
    }
  };
  fs.cpSync = (...args: unknown[]) => { if (state.active) { allowed(args[0]); allowed(args[1]); } return original.cpSync(...args); };
  promises.cp = async (src: string, dest: string, ...args: unknown[]) => {
    if (state.active) { allowed(src); allowed(dest); }
    const run = () => original.cp(src, dest, ...args) as Promise<void>;
    return state.active && state.onCopy ? state.onCopy(src, dest, run) : run();
  };
  syncBuiltinESMExports();
  if ((await import('node:child_process')).spawnSync !== cp.spawnSync
    || (await import('node:fs')).readFileSync !== fs.readFileSync
    || (await import('node:fs/promises')).cp !== promises.cp) throw new Error('J078 actual builtin binding mismatch');
  return { state, restore: () => {
    fs.readFileSync = original.read; fs.cpSync = original.cpSync; promises.cp = original.cp;
    for (const key of Object.keys(original.child)) cp[key] = original.child[key];
    http.request = original.httpRequest; https.request = original.httpsRequest;
    http.createServer = original.httpServer; net.createServer = original.netServer;
    process.kill = original.kill; globalThis.fetch = original.fetch; syncBuiltinESMExports();
  } };
});
// Unselected legacy cases retain their own existing boundaries and assertions.
j078BeforeEach(() => { j078Boundary.state.active = Boolean(expect.getState().currentTestName?.includes('J078')); });
j078AfterAll(() => {
  try { expect(j078Boundary.state.attempts).toEqual([]); }
  finally { j078Boundary.restore(); }
});
