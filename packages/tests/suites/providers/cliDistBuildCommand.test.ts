import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { parseWorkspaceLockLeaseValue } from '@happier-dev/cli-common/workspaceLockLease';
import { describe, expect, it, vi } from 'vitest';

import { ensureCliDistBuilt, ensureCliSharedDepsBuilt, resolveCliDistBuildInvocation, withCliDistBuildLock } from '../../src/testkit/process/cliDist';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { sleep } from '../../src/testkit/timing';
import { yarnCommand } from '../../src/testkit/process/commands';

function writeSharedDepWorkspacePackageManifest(repoRoot: string, packageName: 'agents' | 'cli-common' | 'protocol' | 'release-runtime') {
  const packageDir = resolve(repoRoot, 'packages', packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    resolve(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: `@happier-dev/${packageName}`,
        type: 'module',
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
  writeFileSync(resolve(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2), 'utf8');
}

function writeSharedDepsOutputs(repoRoot: string) {
  const outputs = [
    resolve(repoRoot, 'packages', 'agents', 'dist', 'index.js'),
    resolve(repoRoot, 'packages', 'cli-common', 'dist', 'index.js'),
    resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'),
    resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'),
  ];

  for (const packageName of ['agents', 'cli-common', 'protocol', 'release-runtime'] as const) {
    writeSharedDepWorkspacePackageManifest(repoRoot, packageName);
  }

  for (const output of outputs) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'export {};\n', 'utf8');
  }

  for (const packageName of ['agents', 'cli-common', 'protocol', 'release-runtime'] as const) {
    writeCliBundledWorkspacePackage(repoRoot, packageName);
  }
}

function writeCliBundledWorkspacePackage(repoRoot: string, packageName: 'agents' | 'cli-common' | 'protocol' | 'release-runtime') {
  const packageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    resolve(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: `@happier-dev/${packageName}`,
        type: 'module',
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
}

function writeSharedDepsSources(repoRoot: string) {
  for (const packageName of ['agents', 'cli-common', 'protocol', 'release-runtime'] as const) {
    writeSharedDepWorkspacePackageManifest(repoRoot, packageName);
    const sourcePath = resolve(repoRoot, 'packages', packageName, 'src', 'index.ts');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'export {};\n', 'utf8');
  }
}

function writeCliSources(repoRoot: string) {
  const sourceFiles = [
    resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'),
    resolve(repoRoot, 'apps', 'cli', 'package.json'),
    resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'),
  ];

  for (const filePath of sourceFiles) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (filePath.endsWith('package.json')) {
      writeFileSync(filePath, JSON.stringify({ name: '@happier-dev/cli', type: 'module' }, null, 2), 'utf8');
      continue;
    }
    if (filePath.endsWith('tsconfig.json')) {
      writeFileSync(filePath, JSON.stringify({ compilerOptions: {} }, null, 2), 'utf8');
      continue;
    }
    writeFileSync(filePath, 'export {};\n', 'utf8');
  }
}

function writeCliBackupDist(repoRoot: string) {
  const backupDir = resolve(repoRoot, 'apps', 'cli', '.dist.hstack-backup');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(resolve(backupDir, 'index.mjs'), 'export {}\n', 'utf8');
}

function touchPath(filePath: string, whenMs: number) {
  const when = new Date(whenMs);
  utimesSync(filePath, when, when);
}

describe('providers: CLI dist build invocation', () => {
  it('uses the canonical yarn workspace build script', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-cmd-'));
    const invocation = resolveCliDistBuildInvocation({ repoRoot });

    expect(invocation.command).toBe(yarnCommand());
    expect(invocation.args).toEqual(['-s', 'workspace', '@happier-dev/cli', 'build']);
    expect(invocation.cwd).toBe(repoRoot);
  });

  it('J078 uses the real CLI source entrypoint when explicitly requested for local e2e runs', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-source-launch-'));
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');
    const tsconfigPath = resolve(repoRoot, 'apps', 'cli', 'tsconfig.json');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotEntrypoint = resolve(snapshotDir, 'src', 'index.ts');
    const snapshotTsconfigPath = resolve(snapshotDir, 'tsconfig.json');

    mkdirSync(dirname(sourceEntrypoint), { recursive: true });
    writeFileSync(sourceEntrypoint, 'export {};\n', 'utf8');
    writeFileSync(tsconfigPath, '{ "compilerOptions": {} }\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
      },
      {
        repoRoot,
        snapshotDir,
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(generationDir).toContain('cli-dist-snapshot-generation-');
    expect(launchSpec.command).toBe(process.execPath);
    expect(launchSpec.args).toEqual([
      '--preserve-symlinks',
      '--preserve-symlinks-main',
      '--import',
      expect.stringContaining(`${process.platform === 'win32' ? 'tsx\\dist\\esm\\index.mjs' : 'tsx/dist/esm/index.mjs'}`),
      resolve(generationDir, 'src', 'index.ts'),
    ]);
    expect(launchSpec.cwd).toBe(generationDir);
    expect(launchSpec.env).toEqual({
      TSX_TSCONFIG_PATH: resolve(generationDir, 'tsconfig.json'),
    });
  });

  it('J078 uses the real CLI source entrypoint when the harness prefers source launch', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-source-preferred-launch-'));
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');
    const tsconfigPath = resolve(repoRoot, 'apps', 'cli', 'tsconfig.json');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotEntrypoint = resolve(snapshotDir, 'src', 'index.ts');
    const snapshotTsconfigPath = resolve(snapshotDir, 'tsconfig.json');

    mkdirSync(dirname(sourceEntrypoint), { recursive: true });
    writeFileSync(sourceEntrypoint, 'export {};\n', 'utf8');
    writeFileSync(tsconfigPath, '{ "compilerOptions": {} }\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: {},
      },
      {
        repoRoot,
        snapshotDir,
        preferSourceEntrypoint: true,
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(generationDir).toContain('cli-dist-snapshot-generation-');
    expect(launchSpec.command).toBe(process.execPath);
    expect(launchSpec.args).toEqual([
      '--preserve-symlinks',
      '--preserve-symlinks-main',
      '--import',
      expect.stringContaining(`${process.platform === 'win32' ? 'tsx\\dist\\esm\\index.mjs' : 'tsx/dist/esm/index.mjs'}`),
      resolve(generationDir, 'src', 'index.ts'),
    ]);
    expect(launchSpec.cwd).toBe(generationDir);
    expect(launchSpec.env).toEqual({
      TSX_TSCONFIG_PATH: resolve(generationDir, 'tsconfig.json'),
    });
  });

  it('J078 falls back to the CLI source entrypoint when dist snapshot preparation fails', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-source-fallback-launch-'));
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');
    const tsconfigPath = resolve(repoRoot, 'apps', 'cli', 'tsconfig.json');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotEntrypoint = resolve(snapshotDir, 'src', 'index.ts');
    const snapshotTsconfigPath = resolve(snapshotDir, 'tsconfig.json');

    mkdirSync(dirname(sourceEntrypoint), { recursive: true });
    writeFileSync(sourceEntrypoint, 'export {};\n', 'utf8');
    writeFileSync(tsconfigPath, '{ "compilerOptions": {} }\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: {},
      },
      {
        repoRoot,
        snapshotDir,
        runCommand: async () => {
          throw new Error('Shared workspace deps output missing after build: test');
        },
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(generationDir).toContain('cli-dist-snapshot-generation-');
    expect(launchSpec.command).toBe(process.execPath);
    expect(launchSpec.args).toEqual([
      '--preserve-symlinks',
      '--preserve-symlinks-main',
      '--import',
      expect.stringContaining(`${process.platform === 'win32' ? 'tsx\\dist\\esm\\index.mjs' : 'tsx/dist/esm/index.mjs'}`),
      resolve(generationDir, 'src', 'index.ts'),
    ]);
    expect(launchSpec.cwd).toBe(generationDir);
    expect(launchSpec.env).toEqual({
      TSX_TSCONFIG_PATH: resolve(generationDir, 'tsconfig.json'),
    });
  });

  it('J078 falls back to the backup dist snapshot when the main dist folder is missing', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-backup-dist-launch-'));
    writeCliBackupDist(repoRoot);
    writeSharedDepsOutputs(repoRoot);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: {},
      },
      {
        repoRoot,
        snapshotDir: resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot'),
        skipDistIntegrityCheck: true,
        skipSourceFreshnessCheck: true,
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(generationDir).toContain('cli-dist-snapshot-generation-');
    expect(launchSpec.command).toBe(process.execPath);
    expect(launchSpec.args[0]).toBe('--preserve-symlinks');
    expect(launchSpec.args[1]).toContain('.project');
    expect(launchSpec.args[1]).toContain('cli-dist-snapshot');
  });

  it('J078 launches CLI dist snapshots with --preserve-symlinks', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-snapshot-symlink-launch-'));
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const protocolDistDir = resolve(repoRoot, 'packages', 'protocol', 'dist');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(protocolDistDir, { recursive: true });
    writeFileSync(resolve(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(resolve(protocolDistDir, 'index.js'), 'export {};\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: {},
      },
      {
        repoRoot,
        snapshotDir,
        skipDistIntegrityCheck: true,
        skipSourceFreshnessCheck: true,
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(generationDir).toContain('cli-dist-snapshot-generation-');
    expect(launchSpec.command).toBe(process.execPath);
    expect(launchSpec.args[0]).toBe('--preserve-symlinks');
    expect(launchSpec.args[1]).toBe(resolve(generationDir, 'dist', 'index.mjs'));
  });

  it('J078 replaces a healthy dist snapshot when the canonical CLI dist is newer', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-stale-dist-snapshot-'));
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    const canonicalEntrypoint = resolve(distDir, 'index.mjs');
    const snapshotEntrypoint = resolve(snapshotDistDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(snapshotDistDir, { recursive: true });
    mkdirSync(resolve(snapshotDir, 'node_modules'), { recursive: true });
    writeSharedDepsOutputs(repoRoot);
    writeCliSources(repoRoot);
    writeFileSync(canonicalEntrypoint, 'export const marker = "fresh";\n', 'utf8');
    writeFileSync(snapshotEntrypoint, 'export const marker = "stale";\n', 'utf8');
    writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{"v":1}\n', 'utf8');

    const now = Date.now();
    touchPath(snapshotEntrypoint, now - 10_000);
    touchPath(canonicalEntrypoint, now);

    const launchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: resolve(repoRoot, 'logs'),
        env: {},
      },
      {
        repoRoot,
        snapshotDir,
        skipDistIntegrityCheck: true,
        skipSourceFreshnessCheck: true,
      },
    );

    const generationDir = resolve(launchSpec.args.at(-1)!, '..', '..');
    expect(launchSpec.args[1]).not.toBe(snapshotEntrypoint);
    expect(readFileSync(launchSpec.args[1], 'utf8')).toContain('"fresh"');
  });
});

describe('providers: shared deps build lock', () => {
  it('runs shared deps build once for concurrent callers', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-'));
    const testDir = resolve(repoRoot, 'logs');
    mkdirSync(testDir, { recursive: true });
    const lockPath = resolve(repoRoot, 'cli-shared-deps.lock');

    let buildCalls = 0;
    const runCommand = async () => {
      buildCalls += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      writeSharedDepsOutputs(repoRoot);
    };

    await Promise.all([
      ensureCliSharedDepsBuilt(
        { testDir, env: {} },
        { repoRoot, lockPath, runCommand },
      ),
      ensureCliSharedDepsBuilt(
        { testDir, env: {} },
        { repoRoot, lockPath, runCommand },
      ),
    ]);

    expect(buildCalls).toBe(1);
  });

  it('rebuilds shared deps when sources are newer than existing outputs', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-stale-'));
    const testDir = resolve(repoRoot, 'logs');
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
    mkdirSync(testDir, { recursive: true });

    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);

    const now = Date.now();
    const staleOutput = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const newerSource = resolve(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    touchPath(staleOutput, now - 10_000);
    touchPath(newerSource, now);

    let buildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
          writeSharedDepsOutputs(repoRoot);
        },
      },
    );

    expect(buildCalls).toBe(1);
  });

  it('reuses healthy shared deps outputs when launch callers ignore source freshness', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-stale-ok-'));
    const testDir = resolve(repoRoot, 'logs');
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
    mkdirSync(testDir, { recursive: true });

    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);

    const now = Date.now();
    const staleOutput = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const newerSource = resolve(repoRoot, 'packages', 'protocol', 'src', 'index.ts');
    touchPath(staleOutput, now - 10_000);
    touchPath(newerSource, now);

    let buildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(buildCalls).toBe(0);
  });

  it('repairs missing CLI-bundled workspace dist outputs from existing workspace builds', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-bundled-repair-'));
    const testDir = resolve(repoRoot, 'logs');
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
    mkdirSync(testDir, { recursive: true });

    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);
    writeCliBundledWorkspacePackage(repoRoot, 'agents');
    writeCliBundledWorkspacePackage(repoRoot, 'cli-common');
    writeCliBundledWorkspacePackage(repoRoot, 'protocol');
    writeCliBundledWorkspacePackage(repoRoot, 'release-runtime');

    let buildCalls = 0;
    await ensureCliSharedDepsBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(buildCalls).toBe(0);
    expect(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist')).toSatisfy((p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });
    expect(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist')).toSatisfy((p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });
    expect(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist')).toSatisfy((p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });
  });
});

describe('providers: CLI dist build lock discipline', () => {
  it('reuses a healthy dist entrypoint without waiting for the build lock', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-wait-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const entrypoint = resolve(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');

    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);
    mkdirSync(testDir, { recursive: true });

    const holdLock = withCliDistBuildLock(
      async () => {
        await sleep(150);
        return 'held';
      },
      { lockPath, timeoutMs: 5_000, pollIntervalMs: 20 },
    );

    // Let the lock holder acquire first.
    await sleep(20);

    const startedAt = Date.now();
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      { repoRoot, lockPath },
    );
    const elapsedMs = Date.now() - startedAt;
    await holdLock;

    expect(resolved).toBe(entrypoint);
    expect(elapsedMs).toBeLessThan(100);
  });

  it('fails without rebuilding when rebuilds are disabled and dist remains invalid', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-no-rebuild-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');
    const apiChunk = resolve(distDir, 'api-abc.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    writeSharedDepsOutputs(repoRoot);
    writeFileSync(apiChunk, "export const x = () => import('./capability-missing.mjs');\n", 'utf8');

    let buildCalls = 0;
    await expect(
      ensureCliDistBuilt(
        { testDir, env: {} },
        {
          repoRoot,
          lockPath,
          allowRebuild: false,
          waitForAvailabilityMs: 1,
          runCommand: async () => {
            buildCalls += 1;
          },
        },
      ),
    ).rejects.toThrow(/missing chunk imports/i);

    expect(buildCalls).toBe(0);
  });

  it('fails without rebuilding when any dist chunk import is missing (not only capability chunks)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-no-rebuild-generic-missing-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(entrypoint, "export async function run(){ await import('./doctor-missing.mjs'); }\n", 'utf8');
    writeSharedDepsOutputs(repoRoot);

    let buildCalls = 0;
    await expect(
      ensureCliDistBuilt(
        { testDir, env: {} },
        {
          repoRoot,
          lockPath,
          allowRebuild: false,
          waitForAvailabilityMs: 1,
          runCommand: async () => {
            buildCalls += 1;
          },
        },
      ),
    ).rejects.toThrow(/missing chunk imports/i);

    expect(buildCalls).toBe(0);
  });

  it('reuses an existing entrypoint when launch callers ignore dist chunk integrity', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-ignore-chunks-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsOutputs(repoRoot);
    writeFileSync(entrypoint, "export async function run(){ await import('./doctor-missing.mjs'); }\n", 'utf8');

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        skipDistIntegrityCheck: true,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(0);
  });

  it('waits for dist entrypoint to reappear when rebuilds are disabled', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-no-rebuild-wait-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsOutputs(repoRoot);

    let buildCalls = 0;
    setTimeout(() => {
      writeFileSync(entrypoint, 'export {};\n', 'utf8');
    }, 60);

    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        allowRebuild: false,
        waitForAvailabilityMs: 2_000,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(0);
  });

  it('retries dist build when entrypoint is transiently missing after first build attempt', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-retry-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsOutputs(repoRoot);

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
          if (buildCalls < 2) {
            return;
          }
          writeFileSync(entrypoint, 'export {};\n', 'utf8');
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(2);
  });

  it('rebuilds dist when CLI sources are newer than the existing entrypoint', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-stale-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);
    writeCliSources(repoRoot);
    writeFileSync(entrypoint, 'export {};\n', 'utf8');

    const now = Date.now();
    touchPath(entrypoint, now - 10_000);
    touchPath(sourceEntrypoint, now);

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
          writeFileSync(entrypoint, 'export {};\n', 'utf8');
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(1);
  });

  it('reuses a healthy dist after the maximum retry budget when source freshness keeps moving', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-churn-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);
    writeCliSources(repoRoot);

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        runCommand: async () => {
          buildCalls += 1;
          writeFileSync(entrypoint, 'export {};\n', 'utf8');
          const now = Date.now();
          touchPath(entrypoint, now - 5_000);
          touchPath(sourceEntrypoint, now + 5_000);
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(3);
  });

  it('reuses a healthy dist without rebuilding when launch callers ignore source freshness', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-stale-ok-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');
    const sourceEntrypoint = resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsSources(repoRoot);
    writeSharedDepsOutputs(repoRoot);
    writeCliSources(repoRoot);
    writeFileSync(entrypoint, 'export {}\n', 'utf8');

    const now = Date.now();
    touchPath(entrypoint, now - 10_000);
    touchPath(sourceEntrypoint, now);

    let buildCalls = 0;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        skipSourceFreshnessCheck: true,
        runCommand: async () => {
          buildCalls += 1;
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(buildCalls).toBe(0);
  });

  it('forwards the authenticated lease and custom timeout to the nested CLI build', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-dist-timeout-'));
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const testDir = resolve(repoRoot, 'logs');
    const distDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const entrypoint = resolve(distDir, 'index.mjs');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeSharedDepsOutputs(repoRoot);

    let observedTimeoutMs: number | undefined;
    let observedLease: ReturnType<typeof parseWorkspaceLockLeaseValue> = null;
    let observedOwnerToken: string | undefined;
    const resolved = await ensureCliDistBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        buildTimeoutMs: 600_000,
        runCommand: async (params) => {
          observedTimeoutMs = params.timeoutMs;
          observedLease = parseWorkspaceLockLeaseValue(params.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD);
          observedOwnerToken = JSON.parse(readFileSync(lockPath, 'utf8')).token;
          writeFileSync(entrypoint, 'export {};\n', 'utf8');
        },
      },
    );

    expect(resolved).toBe(entrypoint);
    expect(observedTimeoutMs).toBe(600_000);
    expect(observedLease).toEqual({ path: lockPath, token: observedOwnerToken });
  });
});

describe('providers: shared deps build timeout wiring', () => {
  it('forwards a custom shared deps build timeout to the workspace build command', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-timeout-'));
    const testDir = resolve(repoRoot, 'logs');
    const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

    mkdirSync(testDir, { recursive: true });

    let observedTimeoutMs: number | undefined;
    await ensureCliSharedDepsBuilt(
      { testDir, env: {} },
      {
        repoRoot,
        lockPath,
        buildTimeoutMs: 600_000,
        runCommand: async (params) => {
          observedTimeoutMs = params.timeoutMs;
          writeSharedDepsOutputs(repoRoot);
        },
      },
    );

    expect(observedTimeoutMs).toBe(600_000);
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
