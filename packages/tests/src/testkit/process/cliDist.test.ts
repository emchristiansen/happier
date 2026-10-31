import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, utimesSync } from 'node:fs';

import { ensureCliDistBuilt, ensureCliDistSnapshotEntrypoint, ensureCliSharedDepsBuilt, withCliDistBuildLock } from './cliDist';
import { sleep } from '../timing';

const createdDirs: string[] = [];
const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
beforeEach(() => { delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD; });
afterEach(() => {
  if (originalSkipBuild === undefined) delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
  else process.env.HAPPIER_CLI_TEST_SKIP_BUILD = originalSkipBuild;
});

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-test-'));
  createdDirs.push(root);
  await mkdir(join(root, '.project', 'tmp'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli', 'node_modules', '@happier-dev'), { recursive: true });
  for (const pkgName of ['agents', 'cli-common', 'protocol', 'release-runtime']) {
    await mkdir(join(root, 'packages', pkgName, 'src'), { recursive: true });
    await mkdir(join(root, 'packages', pkgName, 'dist'), { recursive: true });
    await mkdir(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist'), {
      recursive: true,
    });
    await writeFile(join(root, 'packages', pkgName, 'package.json'), `{"name":"@happier-dev/${pkgName}"}`, 'utf8');
    await writeFile(
      join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'package.json'),
      `{"name":"@happier-dev/${pkgName}"}`,
      'utf8',
    );
    await writeFile(join(root, 'packages', pkgName, 'tsconfig.json'), '{}', 'utf8');
    await writeFile(join(root, 'packages', pkgName, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    await writeFile(join(root, 'packages', pkgName, 'dist', 'index.js'), 'exports.ok = true;\n', 'utf8');
    await writeFile(
      join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js'),
      'exports.ok = true;\n',
      'utf8',
    );
    const pkgDistPath = join(root, 'packages', pkgName, 'dist', 'index.js');
    const bundledPkgDistPath = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', pkgName, 'dist', 'index.js');
    const pkgOutputTime = new Date('2030-03-09T01:10:00.000Z');
    utimesSync(pkgDistPath, pkgOutputTime, pkgOutputTime);
    utimesSync(bundledPkgDistPath, pkgOutputTime, pkgOutputTime);
  }
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts'), 'export const testOnly = true;\n', 'utf8');
  await writeFile(join(root, 'apps', 'cli', 'dist', 'index.mjs'), 'export const ok = true;\n', 'utf8');
  const baseline = new Date('2026-03-09T00:55:00.000Z');
  for (const target of [
    join(root, 'apps', 'cli', 'package.json'),
    join(root, 'apps', 'cli', 'tsconfig.json'),
    join(root, 'apps', 'cli', 'src'),
    join(root, 'apps', 'cli', 'src', 'index.ts'),
    join(root, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts'),
    join(root, 'apps', 'cli', 'dist'),
    join(root, 'apps', 'cli', 'dist', 'index.mjs'),
  ]) {
    utimesSync(target, baseline, baseline);
  }
  return root;
}

describe('ensureCliDistBuilt', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('consumes downloaded CI dist without rebuilding for checkout timestamps', async () => {
    const repoRoot = await createRepoRoot();
    utimesSync(join(repoRoot, 'apps/cli/src/index.ts'), new Date('2031-01-01'), new Date('2031-01-01'));
    const entrypoint = await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: { ...process.env, HAPPIER_CLI_TEST_SKIP_BUILD: '1' } },
      {
        repoRoot,
        waitForAvailabilityMs: 0,
        // OS command boundary: any compilation would replace the downloaded bytes.
        runCommand: async () => { throw new Error('unexpected CLI rebuild'); },
      },
    );
    expect(entrypoint).toBe(join(repoRoot, 'apps/cli/dist/index.mjs'));
    expect(await readFile(entrypoint, 'utf8')).toBe('export const ok = true;\n');
  });

  it('fails closed when a CI consumer has no downloaded dist', async () => {
    const repoRoot = await createRepoRoot();
    rmSync(join(repoRoot, 'apps/cli/dist/index.mjs'));
    await expect(ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: { ...process.env, HAPPIER_CLI_TEST_SKIP_BUILD: '1' } },
      {
        repoRoot,
        waitForAvailabilityMs: 0,
        runCommand: async () => { throw new Error('unexpected CLI rebuild'); },
      },
    )).rejects.toThrow('Missing CLI dist entrypoint');
  });

  it('does not rebuild when only src test files are newer than dist', async () => {
    const repoRoot = await createRepoRoot();
    const srcTestPath = join(repoRoot, 'apps', 'cli', 'src', 'cliDistBehavior.test.ts');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const older = new Date('2026-03-09T01:00:00.000Z');
    const newer = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(distEntryPath, older, older);
    utimesSync(srcTestPath, newer, newer);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('reuses dist when a rebuilt chunk is newer than sources even if index.mjs stays older', async () => {
    const repoRoot = await createRepoRoot();
    const srcImplPath = join(repoRoot, 'apps', 'cli', 'src', 'feature.ts');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const distChunkPath = join(repoRoot, 'apps', 'cli', 'dist', 'feature-123.mjs');
    await writeFile(srcImplPath, 'export const feature = true;\n', 'utf8');
    await writeFile(distChunkPath, 'export const feature = true;\n', 'utf8');

    const entryTime = new Date('2026-03-09T01:00:00.000Z');
    const sourceTime = new Date('2026-03-09T01:05:00.000Z');
    const chunkTime = new Date('2026-03-09T01:10:00.000Z');
    utimesSync(distEntryPath, entryTime, entryTime);
    utimesSync(srcImplPath, sourceTime, sourceTime);
    utimesSync(distChunkPath, chunkTime, chunkTime);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('does not rebuild just because package metadata files are newer than dist', async () => {
    const repoRoot = await createRepoRoot();
    const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
    const tsconfigPath = join(repoRoot, 'apps', 'cli', 'tsconfig.json');
    const distEntryPath = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
    const outputTime = new Date('2026-03-09T01:00:00.000Z');
    const metadataTime = new Date('2026-03-09T01:05:00.000Z');
    utimesSync(distEntryPath, outputTime, outputTime);
    utimesSync(packageJsonPath, metadataTime, metadataTime);
    utimesSync(tsconfigPath, metadataTime, metadataTime);

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('returns a healthy CLI dist without waiting for an unrelated held build lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');

    let rebuildCalls = 0;
    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliDistBuilt(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            timeoutMs: 1_000,
            runCommand: async () => {
              rebuildCalls += 1;
            },
          },
        );

        const raced = await Promise.race([
          ensurePromise.then(() => 'resolved'),
          sleep(250).then(() => 'pending'),
        ]);
        expect(raced).toBe('resolved');
        await ensurePromise;
      },
      {
        lockPath,
        timeoutMs: 10_000,
        staleAfterMs: 10_000,
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('rebuilds when a vendored runtime dependency is missing from bundled shared deps', async () => {
    const repoRoot = await createRepoRoot();
    const protocolPackageJsonPath = join(repoRoot, 'packages', 'protocol', 'package.json');
    const bundledProtocolPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'package.json',
    );
    const bundledProtocolNodeModulesDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'node_modules',
    );
    const rootZodDir = join(repoRoot, 'node_modules', 'zod');

    await mkdir(rootZodDir, { recursive: true });
    await writeFile(
      protocolPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      bundledProtocolPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(rootZodDir, 'package.json'), '{"name":"zod","version":"4.3.6","main":"index.js"}', 'utf8');
    await writeFile(join(rootZodDir, 'index.js'), 'exports.ok = true;\n', 'utf8');
    rmSync(bundledProtocolNodeModulesDir, { recursive: true, force: true });

    let rebuildCalls = 0;
    await ensureCliDistBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        skipDistIntegrityCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(join(bundledProtocolNodeModulesDir, 'zod'), { recursive: true });
          await writeFile(
            join(bundledProtocolNodeModulesDir, 'zod', 'package.json'),
            '{"name":"zod","version":"4.3.6","main":"index.js"}',
            'utf8',
          );
          await writeFile(join(bundledProtocolNodeModulesDir, 'zod', 'index.js'), 'exports.ok = true;\n', 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('rebuilds when a vendored runtime dependency is missing an exported subpath file', async () => {
    const repoRoot = await createRepoRoot();
    const agentsPackageJsonPath = join(repoRoot, 'packages', 'agents', 'package.json');
    const bundledAgentsPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'package.json',
    );
    const bundledZodDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
    );

    await writeFile(
      agentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      bundledAgentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await mkdir(bundledZodDir, { recursive: true });
    await writeFile(
      join(bundledZodDir, 'package.json'),
      JSON.stringify(
        {
          name: 'zod',
          version: '4.3.6',
          exports: {
            '.': './index.js',
            './v4/core': './v4/core/index.js',
            './v4/locales/*': './v4/locales/*',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(bundledZodDir, 'index.js'), 'exports.ok = true;\n', 'utf8');
    await mkdir(join(bundledZodDir, 'v4', 'locales'), { recursive: true });
    await writeFile(join(bundledZodDir, 'v4', 'locales', 'en.js'), 'export const locale = "en";\n', 'utf8');
    rmSync(join(bundledZodDir, 'v4', 'core'), { recursive: true, force: true });

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await mkdir(join(bundledZodDir, 'v4', 'core'), { recursive: true });
          await writeFile(join(bundledZodDir, 'v4', 'core', 'index.js'), 'export const core = true;\n', 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('rebuilds when bundled workspace exports drift from workspace package.json exports', async () => {
    const repoRoot = await createRepoRoot();
    const workspacePackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledPackageJsonPath = join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json');
    const workspaceSystemTasksDistPath = join(repoRoot, 'packages', 'cli-common', 'dist', 'systemTasks', 'index.js');
    const bundledSystemTasksDistPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'dist',
      'systemTasks',
      'index.js',
    );

    await mkdir(join(workspaceSystemTasksDistPath, '..'), { recursive: true });
    await mkdir(join(bundledSystemTasksDistPath, '..'), { recursive: true });
    await writeFile(workspaceSystemTasksDistPath, 'export const ok = true;\n', 'utf8');
    await writeFile(bundledSystemTasksDistPath, 'export const ok = true;\n', 'utf8');

    const workspacePackageJson = {
      name: '@happier-dev/cli-common',
      exports: {
        '.': { default: './dist/index.js' },
        './systemTasks': { default: './dist/systemTasks/index.js' },
      },
    };
    const staleBundledPackageJson = {
      name: '@happier-dev/cli-common',
      exports: {
        '.': { default: './dist/index.js' },
      },
    };
    await writeFile(workspacePackageJsonPath, JSON.stringify(workspacePackageJson, null, 2), 'utf8');
    await writeFile(bundledPackageJsonPath, JSON.stringify(staleBundledPackageJson, null, 2), 'utf8');

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          rebuildCalls += 1;
          await writeFile(bundledPackageJsonPath, JSON.stringify(workspacePackageJson, null, 2), 'utf8');
        },
      },
    );

    expect(rebuildCalls).toBe(1);
  });

  it('repairs bundled workspace dist when an internal file is missing even though the entrypoint exists', async () => {
    const repoRoot = await createRepoRoot();
    const workspaceNestedFilePath = join(
      repoRoot,
      'packages',
      'protocol',
      'dist',
      'account',
      'settings',
      'accountSettings.js',
    );
    const bundledNestedFilePath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'account',
      'settings',
      'accountSettings.js',
    );

    await mkdir(join(workspaceNestedFilePath, '..'), { recursive: true });
    await writeFile(workspaceNestedFilePath, "export const marker = 'workspace-protocol';\n", 'utf8');
    await mkdir(join(bundledNestedFilePath, '..'), { recursive: true });

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
    expect(existsSync(bundledNestedFilePath)).toBe(true);
  });

  it('retries shared dependency builds when sources change during the first build', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const outputPaths = [
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
    ];
    const initialSourceTime = new Date('2030-03-09T01:18:00.000Z');
    utimesSync(sourcePath, initialSourceTime, initialSourceTime);

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          lockPath: join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock'),
          runCommand: async () => {
            buildCalls += 1;
            const outputTime = buildCalls === 1
              ? new Date('2030-03-09T01:11:00.000Z')
              : new Date('2030-03-09T01:20:00.000Z');
            for (const outputPath of outputPaths) {
              utimesSync(outputPath, outputTime, outputTime);
            }

            if (buildCalls === 1) {
              const newerSourceTime = new Date('2030-03-09T01:19:00.000Z');
              utimesSync(sourcePath, newerSourceTime, newerSourceTime);
            }
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(2);
  });

  it('does not hold the shared-deps lock while the build command reacquires it', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'agents', 'src', 'index.ts');
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
    const outputPaths = [
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
    ];

    utimesSync(sourcePath, new Date('2030-03-09T01:18:00.000Z'), new Date('2030-03-09T01:18:00.000Z'));

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          lockPath,
          timeoutMs: 1_000,
          runCommand: async () => {
            buildCalls += 1;
            await withCliDistBuildLock(
              async () => {
                const outputTime = new Date('2030-03-09T01:20:00.000Z');
                for (const outputPath of outputPaths) {
                  utimesSync(outputPath, outputTime, outputTime);
                }
              },
              {
                lockPath,
                timeoutMs: 100,
                pollIntervalMs: 25,
                staleAfterMs: 1_000,
              },
            );
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(1);
  });

  it('accepts fresh bundled shared deps even when workspace dist is stale', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    const workspaceOutputPath = join(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const bundledOutputPaths = [
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
    ];

    utimesSync(sourcePath, new Date('2030-03-09T01:12:00.000Z'), new Date('2030-03-09T01:12:00.000Z'));
    utimesSync(workspaceOutputPath, new Date('2030-03-09T01:10:00.000Z'), new Date('2030-03-09T01:10:00.000Z'));
    for (const bundledOutputPath of bundledOutputPaths) {
      utimesSync(bundledOutputPath, new Date('2030-03-09T01:20:00.000Z'), new Date('2030-03-09T01:20:00.000Z'));
    }

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let rebuildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        lockPath: join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock'),
        runCommand: async () => {
          rebuildCalls += 1;
        },
      },
    );

    expect(rebuildCalls).toBe(0);
  });

  it('fails open when workspace package.json is missing (bundled outputs are still considered healthy)', async () => {
    const repoRoot = await createRepoRoot();
    rmSync(join(repoRoot, 'packages', 'cli-common', 'package.json'), { force: true });

    vi.resetModules();
    const { ensureCliSharedDepsBuilt } = await import('./cliDist');

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {
            buildCalls += 1;
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(0);
  });

  it('honors skipSourceFreshnessCheck when validating outputs after a rebuild', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = join(repoRoot, 'packages', 'cli-common', 'src', 'index.ts');
    const workspaceCliCommonPackageJsonPath = join(repoRoot, 'packages', 'cli-common', 'package.json');
    const bundledCliCommonPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'package.json',
    );

    // Force the freshness check to consider sources newer than outputs.
    const newerSourceTime = new Date('2030-03-09T01:18:00.000Z');
    utimesSync(sourcePath, newerSourceTime, newerSourceTime);
    const olderOutputTime = new Date('2030-03-09T01:10:00.000Z');

    // Break the bundled manifests (not repairable via dist symlinks) so ensureCliSharedDepsBuilt has to rebuild.
    await writeFile(
      workspaceCliCommonPackageJsonPath,
      JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': { default: './dist/index.js' } } }, null, 2),
      'utf8',
    );
    await writeFile(
      bundledCliCommonPackageJsonPath,
      JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': './dist/index.js' } }, null, 2),
      'utf8',
    );

    let buildCalls = 0;
    await expect(
      ensureCliSharedDepsBuilt(
        { testDir: join(repoRoot, '.project'), env: process.env },
        {
          repoRoot,
          skipSourceFreshnessCheck: true,
          maxBuildAttempts: 1,
          runCommand: async () => {
            buildCalls += 1;
            await writeFile(
              bundledCliCommonPackageJsonPath,
              JSON.stringify({ name: '@happier-dev/cli-common', exports: { '.': { default: './dist/index.js' } } }, null, 2),
              'utf8',
            );

            // Keep the output older than the source: skipSourceFreshnessCheck must still accept it.
            utimesSync(bundledCliCommonPackageJsonPath, olderOutputTime, olderOutputTime);
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(buildCalls).toBe(1);
  });

  it('returns healthy shared deps without waiting for an unrelated held shared-deps lock', async () => {
    const repoRoot = await createRepoRoot();
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

    let rebuildCalls = 0;
    await withCliDistBuildLock(
      async () => {
        const ensurePromise = ensureCliSharedDepsBuilt(
          { testDir: join(repoRoot, '.project'), env: process.env },
          {
            repoRoot,
            lockPath,
            timeoutMs: 1_000,
            skipSourceFreshnessCheck: true,
            runCommand: async () => {
              rebuildCalls += 1;
            },
          },
        );

        const raced = await Promise.race([
          ensurePromise.then(() => 'resolved'),
          sleep(250).then(() => 'pending'),
        ]);
        expect(raced).toBe('resolved');
        await ensurePromise;
      },
      {
        lockPath,
        timeoutMs: 10_000,
        staleAfterMs: 10_000,
      },
    );

    expect(rebuildCalls).toBe(0);
  });
});

describe('ensureCliDistSnapshotEntrypoint', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('J078 repairs missing bundled runtime dependency files in a new generation while retaining the old snapshot', async () => {
    const repoRoot = await createRepoRoot();
    const snapshotDir = join(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = join(snapshotDir, 'dist');
    const snapshotReadyMarkerPath = join(snapshotDir, '.cli-dist-snapshot.ready.json');

    const bundledAgentsPackageJsonPath = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'package.json',
    );
    const bundledAgentsZodDir = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
    );

    await mkdir(bundledAgentsZodDir, { recursive: true });
    await writeFile(
      bundledAgentsPackageJsonPath,
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      join(bundledAgentsZodDir, 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }),
      'utf8',
    );
    await writeFile(join(bundledAgentsZodDir, 'index.js'), 'export const live = "source-zod";\n', 'utf8');

    await mkdir(snapshotDistDir, { recursive: true });
    await writeFile(join(snapshotDistDir, 'index.mjs'), 'export const ok = true;\n', 'utf8');
    await mkdir(join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }),
      'utf8',
    );
    await writeFile(snapshotReadyMarkerPath, JSON.stringify({ v: 1 }), 'utf8');

    const snapshotEntrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: join(repoRoot, '.project'), env: process.env },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('unexpected dist rebuild');
        },
      },
    );

    expect(snapshotEntrypoint).not.toBe(join(snapshotDistDir, 'index.mjs'));
    const repairedIndexFilePath = join(
      snapshotEntrypoint, '..', '..',
      'node_modules',
      '@happier-dev',
      'agents',
      'node_modules',
      'zod',
      'index.js',
    );
    expect(existsSync(join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'index.js'))).toBe(false);
    expect(existsSync(repairedIndexFilePath)).toBe(true);
    await expect(readFile(repairedIndexFilePath, 'utf8')).resolves.toContain('source-zod');
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

describe('J078 returned dist generation lifetime', () => {
  afterEach(() => { j078Boundary.state.onCopy = null; });
  async function fixture() {
    const root = await createRepoRoot();
    const snapshotDir = join(root, '.project', 'tmp', 'cli-dist-snapshot');
    const canonical = join(root, 'apps', 'cli', 'dist', 'index.mjs');
    await writeFile(canonical, 'export const generation = "A";\n');
    await writeFile(join(root, 'apps', 'cli', 'dist', 'lazy.mjs'), 'export const lazy = "A";\n');
    const prepare = () => ensureCliDistSnapshotEntrypoint({ testDir: root, env: { CI: '1', HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy' } }, {
      repoRoot: root, snapshotDir, skipSourceFreshnessCheck: true,
      runCommand: async () => { throw new Error('J078 unexpected build'); },
    });
    const advance = async () => {
      await writeFile(canonical, 'export const generation = "B";\n');
      await writeFile(join(root, 'apps', 'cli', 'dist', 'lazy.mjs'), 'export const lazy = "B";\n');
      utimesSync(canonical, new Date('2035-01-01'), new Date('2035-01-01'));
    };
    return { root, snapshotDir, canonical, prepare, advance };
  }
  it('J078 retains entrypoint and lazy chunks after the next same-namespace preparation', async () => {
    const f = await fixture(); const a = await f.prepare(); await f.advance(); const b = await f.prepare();
    expect(b).not.toBe(a);
    expect(await readFile(a, 'utf8')).toContain('"A"');
    expect(await readFile(join(a, '..', 'lazy.mjs'), 'utf8')).toContain('"A"');
    expect(await readFile(b, 'utf8')).toContain('"B"');
  });
  it('J078 keeps an existing consumer readable while a later copy is held', async () => {
    const f = await fixture(); const a = await f.prepare(); await f.advance();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    j078Boundary.state.onCopy = async (src, _dest, run) => {
      if (src === join(f.root, 'apps', 'cli', 'dist')) { entered(); await gate; }
      await run();
    };
    const pending = f.prepare();
    try { await started; expect(await readFile(a, 'utf8')).toContain('"A"'); }
    finally { release(); await pending; }
  });
  it('J078 preserves the returned generation when a subsequent copy rejects', async () => {
    const f = await fixture(); const a = await f.prepare(); await f.advance();
    const error = new Error('fixture copy rejected');
    j078Boundary.state.onCopy = async () => { throw error; };
    await expect(f.prepare()).rejects.toBe(error);
    expect(await readFile(a, 'utf8')).toContain('"A"');
  });
  it('J078 scopes an ENOENT retry to the unpublished allocation', async () => {
    const f = await fixture(); const a = await f.prepare(); await f.advance(); let failed = false;
    j078Boundary.state.onCopy = async (_src, _dest, run) => {
      if (!failed) { failed = true; throw Object.assign(new Error('fixture copy race'), { code: 'ENOENT' }); }
      await run();
    };
    const b = await f.prepare(); expect(failed).toBe(true); expect(b).not.toBe(a);
    expect(await readFile(a, 'utf8')).toContain('"A"'); expect(await readFile(b, 'utf8')).toContain('"B"');
  });
  it('J078 reconciles dependencies in a new generation without rewriting a ready consumer', async () => {
    const f = await fixture(); const a = await f.prepare();
    const relative = ['node_modules', '@happier-dev', 'protocol', 'package.json'];
    const aPackage = join(a, '..', '..', ...relative); const original = await readFile(aPackage, 'utf8');
    await writeFile(join(f.root, 'packages', 'protocol', 'package.json'), '{"name":"@happier-dev/protocol","version":"2"}');
    const b = await f.prepare();
    expect(await readFile(aPackage, 'utf8')).toBe(original);
    expect(await readFile(join(b, '..', '..', ...relative), 'utf8')).toContain('"version":"2"');
  });
  it('J078 preserves an incomplete pre-existing logical namespace', async () => {
    const f = await fixture(); await mkdir(f.snapshotDir, { recursive: true });
    const sentinel = join(f.snapshotDir, 'borrowed.txt'); await writeFile(sentinel, 'preserve');
    const a = await f.prepare(); expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    expect(a).not.toBe(join(f.snapshotDir, 'dist', 'index.mjs'));
  });
  it('J078 keeps two real resolver calls independent at the default shared namespace', async () => {
    const f = await fixture(); const { resolveCliTestLaunchSpec } = await import('./cliLaunchSpec');
    const params = { testDir: f.root, env: { HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy' } };
    const options = { repoRoot: f.root, snapshotDir: f.snapshotDir, skipSourceFreshnessCheck: true,
      runCommand: async () => { throw new Error('unexpected build'); } };
    const a = await resolveCliTestLaunchSpec(params, options); await f.advance();
    const b = await resolveCliTestLaunchSpec(params, options);
    expect(a.args[1]).not.toBe(b.args[1]);
    expect(await readFile(a.args[1], 'utf8')).toContain('"A"');
    expect(await readFile(b.args[1], 'utf8')).toContain('"B"');
  });
  it('J078 source fallback cannot reuse a prior returned dist generation', async () => {
    const f = await fixture(); const a = await f.prepare(); rmSync(join(f.root, 'apps', 'cli', 'dist'), { recursive: true });
    const { resolveCliTestLaunchSpec } = await import('./cliLaunchSpec');
    const fallback = await resolveCliTestLaunchSpec({ testDir: f.root, env: { HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } }, {
      repoRoot: f.root, snapshotDir: f.snapshotDir, skipSourceFreshnessCheck: true,
      runCommand: async () => { throw new Error('fixture dist unavailable'); },
    });
    expect(fallback.args).toContain('--import');
    expect(fallback.cwd).not.toBe(join(a, '..', '..'));
    expect(await readFile(a, 'utf8')).toContain('"A"');
    expect(await readFile(join(a, '..', 'lazy.mjs'), 'utf8')).toContain('"A"');
  });
  it('J078 returns with the preparation lock released without reclaiming its generation', async () => {
    const f = await fixture(); const a = await f.prepare();
    expect(existsSync(join(f.root, '.project', 'tmp', 'cli-dist-build.lock'))).toBe(false);
    expect(await readFile(a, 'utf8')).toContain('"A"');
  });
  it('J078 detaches symlink-selected runtime files before returning', async () => {
    const f = await fixture(); const dependency = join(f.root, 'apps', 'cli', 'node_modules', 'local-lazy');
    await mkdir(dependency, { recursive: true }); await writeFile(join(dependency, 'index.js'), 'original');
    const a = await ensureCliDistSnapshotEntrypoint({ testDir: f.root, env: { CI: '1', HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink' } }, {
      repoRoot: f.root, snapshotDir: f.snapshotDir, skipSourceFreshnessCheck: true,
      runCommand: async () => { throw new Error('unexpected build'); },
    });
    rmSync(dependency, { recursive: true });
    expect(await readFile(join(a, '..', '..', 'node_modules', 'local-lazy', 'index.js'), 'utf8')).toBe('original');
  });
});
