import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const sharedDepsBuildMock = vi.hoisted(() => ({
  ensureCliSharedDepsBuilt: vi.fn(async ({ testDir, env }: { testDir: string; env: NodeJS.ProcessEnv }) => {
    void testDir;
    void env;
  }),
  ensureCliDistSnapshotEntrypoint: vi.fn(
    async (
      _params: { testDir: string; env: NodeJS.ProcessEnv },
      _options: { repoRoot?: string; snapshotDir: string },
    ) => resolve(_options.snapshotDir, 'dist', 'index.mjs'),
  ),
}));

vi.mock('./cliDist', async () => {
  const actual = await vi.importActual<typeof import('./cliDist')>('./cliDist');
  return {
    ...actual,
    ensureCliSharedDepsBuilt: sharedDepsBuildMock.ensureCliSharedDepsBuilt,
    ensureCliDistSnapshotEntrypoint: sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint,
  };
});

import { resolveCliTestLaunchSpec } from './cliLaunchSpec';

describe('resolveCliTestLaunchSpec', () => {
  it('launches an already-prepared dist snapshot without rebuilding or falling back to source mode', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-prepared-'));
    const snapshotDir = resolve(repoRoot, 'prepared-snapshot');

    try {
      mkdirSync(resolve(snapshotDir, 'dist'), { recursive: true });
      mkdirSync(resolve(snapshotDir, 'node_modules'), { recursive: true });
      writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{"v":1}\n', 'utf8');
      writeFileSync(resolve(snapshotDir, 'dist', 'index.mjs'), 'export {};\n', 'utf8');

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();
      sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint.mockClear();

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
        },
        {
          repoRoot,
          snapshotDir,
          preparedDistSnapshotOnly: true,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).not.toHaveBeenCalled();
      expect(sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint).not.toHaveBeenCalled();
      expect(spec).toEqual({
        command: process.execPath,
        args: ['--preserve-symlinks', resolve(snapshotDir, 'dist', 'index.mjs')],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('launches an already-verified binary release payload through its packaged Node entrypoint', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-release-'));
    const snapshotDir = resolve(repoRoot, 'release-snapshot');

    try {
      mkdirSync(resolve(snapshotDir, 'package-dist'), { recursive: true });
      mkdirSync(resolve(snapshotDir, 'node_modules'), { recursive: true });
      writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{"v":1}\n', 'utf8');
      writeFileSync(resolve(snapshotDir, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');

      await expect(resolveCliTestLaunchSpec(
        { testDir: resolve(repoRoot, '.project'), env: process.env },
        { repoRoot, snapshotDir, preparedDistSnapshotOnly: true },
      )).resolves.toEqual({
        command: process.execPath,
        args: ['--preserve-symlinks', resolve(snapshotDir, 'package-dist', 'index.mjs')],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('J078 ensures source-entrypoint launches refresh shared deps before snapshotting bundled node_modules', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, '.project'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/release-runtime',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
              '.': { default: './dist/index.js' },
              './github': { default: './dist/github.js' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({ name: '@happier-dev/release-runtime' }),
        'utf8',
      );

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockImplementationOnce(async () => {
        mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
          recursive: true,
        });
        writeFileSync(
          resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
          'export const live = true;\n',
          'utf8',
        );
      });

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      const launchDir = spec.cwd!;
      expect(launchDir).not.toBe(snapshotDir);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain('--preserve-symlinks');
      expect(spec.args).toContain('--preserve-symlinks-main');
      expect(spec.args).toContain(resolve(launchDir, 'src', 'index.ts'));
      expect(existsSync(resolve(launchDir, 'scripts', 'claude_launcher_runtime.cjs'))).toBe(true);
      expect(existsSync(resolve(launchDir, 'tools', 'launch-helper.txt'))).toBe(true);
      expect(existsSync(resolve(launchDir, 'bin', 'launch-helper.txt'))).toBe(true);
      expect(existsSync(resolve(launchDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'))).toBe(true);
      const nodeModulesEntry = lstatSync(resolve(launchDir, 'node_modules'));
      expect(nodeModulesEntry.isSymbolicLink() || nodeModulesEntry.isDirectory()).toBe(true);
      expect(spec.env?.TSX_TSCONFIG_PATH).toBe(resolve(launchDir, 'tsconfig.json'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('J078 can skip refreshing shared deps when source-entrypoint launches only need existing outputs', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-skip-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/release-runtime',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
              '.': { default: './dist/index.js' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({ name: '@happier-dev/release-runtime' }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'), 'export {};\n', 'utf8');

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).not.toHaveBeenCalled();
      const launchDir = spec.cwd!;
      expect(launchDir).not.toBe(snapshotDir);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(launchDir, 'src', 'index.ts'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('J078 detaches symlink-selected node_modules for source-entrypoint launches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-symlink-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      const launchDir = spec.cwd!;
      expect(launchDir).not.toBe(snapshotDir);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(launchDir, 'src', 'index.ts'));
      expect(lstatSync(resolve(launchDir, 'node_modules')).isDirectory()).toBe(true);
      expect(existsSync(resolve(launchDir, 'scripts', 'claude_launcher_runtime.cjs'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('J078 prepares detached dependencies without replacing a stale copied snapshot', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-symlink-replace-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'left-pad'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'left-pad', 'index.js'), 'module.exports = (v) => v;\n', 'utf8');

      mkdirSync(resolve(snapshotDir, 'node_modules', 'stale-only'), { recursive: true });
      writeFileSync(resolve(snapshotDir, 'node_modules', 'stale-only', 'index.js'), 'module.exports = "stale";\n', 'utf8');

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      const launchDir = spec.cwd!;
      expect(launchDir).not.toBe(snapshotDir);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(launchDir, 'src', 'index.ts'));
      expect(lstatSync(resolve(launchDir, 'node_modules')).isDirectory()).toBe(true);
      expect(existsSync(resolve(launchDir, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
      expect(existsSync(resolve(launchDir, 'node_modules', 'stale-only', 'index.js'))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('J078 repairs incomplete dependencies in a new source generation', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-repair-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'agents', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'node_modules', 'zod'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'packages', 'agents', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'packages', 'agents', 'dist', 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'node_modules', 'zod', 'package.json'),
        JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'node_modules', 'zod', 'index.js'), 'export const repaired = "root";\n', 'utf8');

      mkdirSync(resolve(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), { recursive: true });
      writeFileSync(
        resolve(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
        'export const partial = true;\n',
        'utf8',
      );

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      const launchDir = spec.cwd!;
      expect(launchDir).not.toBe(snapshotDir);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(launchDir, 'src', 'index.ts'));
      expect(readFileSync(resolve(launchDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'index.js'), 'utf8')).toContain(
        'repaired',
      );
      expect(readFileSync(resolve(launchDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'), 'utf8')).toContain(
        '"name": "zod"',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
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

describe('J078 resolver lifetime and borrowed inputs', () => {
  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'j078-resolver-'));
    for (const name of ['src', 'scripts', 'tools', 'bin', 'node_modules']) mkdirSync(resolve(root, 'apps', 'cli', name), { recursive: true });
    writeFileSync(resolve(root, 'apps', 'cli', 'src', 'index.ts'), 'export const value = "A";');
    writeFileSync(resolve(root, 'apps', 'cli', 'scripts', 'lazy.cjs'), 'module.exports = "A";');
    writeFileSync(resolve(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}');
    writeFileSync(resolve(root, 'apps', 'cli', 'tsconfig.json'), '{}');
    // Use the real dist owner for new lifetime cases; the existing build mock is a positive
    // boundary for source-only fixture tests and remains uncalled in borrowed prepared mode.
    const actual = await vi.importActual<typeof import('./cliDist')>('./cliDist');
    sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint.mockImplementation(actual.ensureCliDistSnapshotEntrypoint);
    sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockImplementation(async () => {});
    const env = { HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink' };
    const options = { repoRoot: root, snapshotDir: resolve(root, 'cli-source-snapshot'), skipSourceFreshnessCheck: true,
      runCommand: async () => { throw new Error('fixture dist unavailable'); } };
    return { root, env, options };
  }
  it.each(['explicit', 'preferred'] as const)('J078 retains %s source files and scaffolding after later preparation', async (mode) => {
    const f = await fixture();
    try {
      const env = { ...f.env, ...(mode === 'explicit' ? { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } : {}) };
      const options = { ...f.options, preferSourceEntrypoint: mode === 'preferred' };
      const a = await resolveCliTestLaunchSpec({ testDir: f.root, env }, options);
      writeFileSync(resolve(f.root, 'apps', 'cli', 'src', 'index.ts'), 'export const value = "B";');
      writeFileSync(resolve(f.root, 'apps', 'cli', 'scripts', 'lazy.cjs'), 'module.exports = "B";');
      const b = await resolveCliTestLaunchSpec({ testDir: f.root, env }, options);
      expect(a.cwd).not.toBe(b.cwd);
      expect(readFileSync(a.args.at(-1)!, 'utf8')).toContain('"A"');
      expect(readFileSync(resolve(a.cwd!, 'scripts', 'lazy.cjs'), 'utf8')).toContain('"A"');
      expect(a.env?.TSX_TSCONFIG_PATH).toBe(resolve(a.cwd!, 'tsconfig.json'));
      expect(readFileSync(b.args.at(-1)!, 'utf8')).toContain('"B"');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('J078 isolates source fallback from the old returned snapshot and refuses an incomplete fallback', async () => {
    const f = await fixture();
    try {
      const a = await resolveCliTestLaunchSpec({ testDir: f.root, env: f.env }, f.options);
      expect(a.args).toContain('--import'); // Real dist build boundary rejected before source fallback.
      writeFileSync(resolve(f.root, 'apps', 'cli', 'src', 'index.ts'), 'export const value = "B";');
      const b = await resolveCliTestLaunchSpec({ testDir: f.root, env: f.env }, f.options);
      expect(a.args.at(-1)).not.toBe(b.args.at(-1));
      expect(readFileSync(a.args.at(-1)!, 'utf8')).toContain('"A"');
      rmSync(resolve(f.root, 'apps', 'cli', 'src'), { recursive: true });
      await expect(resolveCliTestLaunchSpec({ testDir: f.root, env: f.env }, f.options)).rejects.toThrow('fixture dist unavailable');
      expect(readFileSync(a.args.at(-1)!, 'utf8')).toContain('"A"');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['dist', 'package-dist'])('J078 preserves exact borrowed %s prepared input without allocation or fallback', async (kind) => {
    const f = await fixture(); const snapshotDir = resolve(f.root, 'borrowed');
    try {
      mkdirSync(resolve(snapshotDir, kind), { recursive: true }); mkdirSync(resolve(snapshotDir, 'node_modules'));
      writeFileSync(resolve(snapshotDir, kind, 'index.mjs'), 'borrowed');
      writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{}');
      sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint.mockClear(); sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();
      const spec = await resolveCliTestLaunchSpec({ testDir: f.root, env: f.env }, { ...f.options, snapshotDir, preparedDistSnapshotOnly: true });
      expect(spec.args).toEqual(['--preserve-symlinks', resolve(snapshotDir, kind, 'index.mjs')]);
      expect(sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint).not.toHaveBeenCalled();
      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).not.toHaveBeenCalled();
      expect(readFileSync(spec.args[1], 'utf8')).toBe('borrowed');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['ready', 'entrypoint', 'node_modules'])('J078 refuses missing borrowed prepared %s before fallback', async (missing) => {
    const f = await fixture(); const snapshotDir = resolve(f.root, 'borrowed');
    try {
      mkdirSync(resolve(snapshotDir, 'dist'), { recursive: true });
      if (missing !== 'node_modules') mkdirSync(resolve(snapshotDir, 'node_modules'));
      if (missing !== 'entrypoint') writeFileSync(resolve(snapshotDir, 'dist', 'index.mjs'), 'borrowed');
      if (missing !== 'ready') writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{}');
      const { readdirSync } = await import('node:fs'); const before = readdirSync(f.root).sort();
      await expect(resolveCliTestLaunchSpec({ testDir: f.root, env: f.env }, { ...f.options, snapshotDir, preparedDistSnapshotOnly: true })).rejects.toThrow('already-prepared');
      expect(readdirSync(f.root).sort()).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
