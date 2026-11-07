import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { chmodSync, closeSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRetainedCliSnapshot, ensureCliDistSnapshotNodeModules, ensureCliPackSnapshotRuntimeDependencies, isPathStrictlyInside,
} from './cliDistSnapshotNodeModules';

const createdDirs: string[] = [];

function createRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-'));
  createdDirs.push(root);
  mkdirSync(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'esm'), {
    recursive: true,
  });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'), '{"name":"@happier-dev/protocol"}', 'utf8');
  writeFileSync(
    join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'),
    'export const live = "initial";\n',
    'utf8',
  );
  return root;
}

describe('ensureCliDistSnapshotNodeModules', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('J078 copies the bundled @happier-dev scope into the snapshot instead of aliasing the live tree', () => {
    const rootDir = createRepoRoot();
    const rootMirrorDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-out-'));
    createdDirs.push(rootMirrorDir);
    const snapshotDir = resolve(rootMirrorDir, 'apps', 'cli');
    mkdirSync(resolve(snapshotDir, 'dist'), { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootMirrorDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'),
      'export const live = "mutated";\n',
      'utf8',
    );

    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('J078 copies direct CLI dependencies into the snapshot so built dist can resolve them', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-direct-deps-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'), '{"name":"zod"}', 'utf8');
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const live = "initial";\n', 'utf8');

    const rootMirrorDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-direct-deps-out-'));
    createdDirs.push(rootMirrorDir);
    const snapshotDir = resolve(rootMirrorDir, 'apps', 'cli');
    mkdirSync(resolve(snapshotDir, 'dist'), { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootMirrorDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', 'zod', 'index.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');

    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const live = "mutated";\n', 'utf8');

    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('vendors runtime dependencies for copied external packages so nested imports resolve', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-external-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', '@sentry', 'node-core'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node', 'package.json'),
      JSON.stringify({
        name: '@sentry/node',
        version: '10.39.0',
        dependencies: {
          '@sentry/node-core': '10.39.0',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@sentry', 'node', 'index.js'),
      'export const live = "sentry-node";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', '@sentry', 'node-core', 'package.json'),
      JSON.stringify({
        name: '@sentry/node-core',
        version: '10.39.0',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', '@sentry', 'node-core', 'index.js'),
      'export const live = "sentry-node-core";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-external-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotCoreFile = join(
      snapshotDir,
      'node_modules',
      '@sentry',
      'node',
      'node_modules',
      '@sentry',
      'node-core',
      'index.js',
    );
    expect(readFileSync(snapshotCoreFile, 'utf8')).toContain('sentry-node-core');
  });

  it('copies deep bundled runtime dependencies into the snapshot so nested protocol imports resolve', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-deep-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({
        name: 'tweetnacl',
        version: '1.0.3',
        main: 'nacl-fast.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
      'export const live = "initial";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-deep-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotFile = join(
      snapshotDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'node_modules',
      'tweetnacl',
      'nacl-fast.js',
    );
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('materializes symlinked bundled runtime dependencies into the snapshot', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlinked-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "source";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents' }, null, 2),
      'utf8',
    );
    symlinkSync(
      resolve(rootDir, 'node_modules', 'zod'),
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'),
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-symlinked-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotZodDir = join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod');
    expect(lstatSync(snapshotZodDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(snapshotZodDir, 'package.json'), 'utf8')).toContain('"name": "zod"');
    expect(readFileSync(join(snapshotZodDir, 'index.js'), 'utf8')).toContain('source');
  });

  it('backfills missing bundled workspace runtime dependencies from the source root node_modules tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4-mini'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
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
    writeFileSync(
      join(rootDir, 'packages', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: '4.3.6',
        main: 'index.js',
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "source-root";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
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
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const partial = "nested";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4-mini', 'index.js'),
      'export const partialMini = "nested";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotZodDir = join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod');
    expect(existsSync(snapshotZodDir)).toBe(true);
    expect(lstatSync(snapshotZodDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(snapshotZodDir, 'package.json'), 'utf8')).toContain('"name": "zod"');
    expect(readFileSync(join(snapshotZodDir, 'index.js'), 'utf8')).toContain('source-root');
  });

  it('repairs incomplete CLI-local runtime deps by merging in missing files from root node_modules', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-merge-runtime-'));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod', 'v4', 'locales'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'agents', 'dist', 'index.js'), 'export const agent = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const agent = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const cliRoot = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const cliRootV4 = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
      'export const bundledPartial = true;\n',
      'utf8',
    );

    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const rootFull = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'v4', 'index.js'),
      'export const rootV4 = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'v4', 'locales', 'ru.js'),
      'export default "ru";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-merge-runtime-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    expect(
      readFileSync(
        join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'locales', 'ru.js'),
        'utf8',
      ),
    ).toContain('ru');
  });

  it('repairs missing bundled workspace runtime deps from the root node_modules tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-fallback-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'protocol', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'protocol', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          dependencies: {
            zod: '4.3.6',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'protocol', 'dist', 'index.js'),
      'export const protocol = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify(
        {
          name: 'zod',
          version: '4.3.6',
          main: 'index.js',
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(rootDir, 'node_modules', 'zod', 'index.js'), 'export const live = "root-zod";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-runtime-fallback-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    expect(
      readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'zod', 'index.js'), 'utf8'),
    ).toContain('root-zod');
  });

  it('ignores transient dist.__sync_tmp__ directories when copying bundled workspace scopes', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-transient-sync-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'),
      '{"name":"@happier-dev/cli-common"}',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      'export const stable = "stable";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2', 'index.js'),
      'export const transient = "transient";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-transient-sync-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    expect(readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'utf8')).toContain(
      'stable',
    );
    expect(existsSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'dist.__sync_tmp__.58760.2'))).toBe(false);
  });

  it('repairs incomplete bundled workspace copies by filling in missing dist files', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-bundled-repair-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      '{"name":"@happier-dev/release-runtime"}',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
      'export const live = "initial";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-bundled-repair-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      '{"name":"@happier-dev/release-runtime"}',
      'utf8',
    );

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('initial');
  });

  it('repairs missing workspace package manifests in the copied @happier-dev scope', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-manifest-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'connection-supervisor', 'dist'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'connection-supervisor', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'connection-supervisor', 'dist', 'index.js'),
      'export const live = "initial";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'connection-supervisor', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/connection-supervisor',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'connection-supervisor', 'dist', 'index.js'), 'export const workspace = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-manifest-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotPackageJson = join(snapshotDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'package.json');
    expect(readFileSync(snapshotPackageJson, 'utf8')).toContain('@happier-dev/connection-supervisor');
  });

  it('copies workspace package root files referenced by package exports', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-export-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'cli-common', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          '.': { default: './dist/index.js' },
          './processInstance': {
            types: './processInstance.d.mts',
            import: './processInstance.mjs',
            default: './processInstance.mjs',
          },
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'cli-common', 'dist', 'index.js'), 'export const common = true;\n', 'utf8');
    writeFileSync(join(rootDir, 'packages', 'cli-common', 'processInstance.mjs'), 'export const processInstance = true;\n', 'utf8');
    writeFileSync(join(rootDir, 'packages', 'cli-common', 'processInstance.d.mts'), 'export declare const processInstance: true;\n', 'utf8');

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common', version: '0.0.0', type: 'module' }),
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-root-export-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    expect(readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'processInstance.mjs'), 'utf8')).toContain(
      'processInstance',
    );
    expect(existsSync(join(snapshotDir, 'node_modules', '@happier-dev', 'cli-common', 'processInstance.d.mts'))).toBe(true);
  });

  it('overwrites stale bundled workspace manifests with canonical package manifests', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-stale-manifest-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'agents', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        exports: { '.': { default: './index.js' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'),
      'export const bundled = true;\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'packages', 'agents', 'dist', 'index.js'), 'export const workspace = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-stale-manifest-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotPackageJson = JSON.parse(
      readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'package.json'), 'utf8'),
    ) as { main?: unknown; exports?: { '.': { default?: unknown } } };
    expect(snapshotPackageJson.main).toBe('./dist/index.js');
    expect(snapshotPackageJson.exports?.['.']?.default).toBe('./dist/index.js');
  });

  it('repairs missing workspace dist files from the source package tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-dist-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'packages', 'release-runtime', 'dist'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          './github': './dist/github.js',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'release-runtime', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          './github': './dist/github.js',
        },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages', 'release-runtime', 'dist', 'github.js'),
      'export const live = "workspace-dist";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-dist-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const snapshotFile = join(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js');
    expect(readFileSync(snapshotFile, 'utf8')).toContain('workspace-dist');
  });

  it('hydrates packed cli snapshots with missing top-level and bundled runtime dependencies without replacing the packed payload', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-runtime-'));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl'), {
      recursive: true,
    });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const z = "source";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '1.0.3', main: 'nacl-fast.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
      'export const nacl = "source";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-runtime-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'dist'), { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(snapshotDir, 'dist', 'index.mjs'), 'export const cli = true;\n', 'utf8');
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0-test',
        dependencies: { tweetnacl: '^1.0.3' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist-marker.txt'),
      'packed-payload',
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('source');
    expect(
      readFileSync(
        join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'nacl-fast.js'),
        'utf8',
      ),
    ).toContain('source');
    expect(readFileSync(join(snapshotDir, 'node_modules', '@happier-dev', 'protocol', 'dist-marker.txt'), 'utf8')).toBe(
      'packed-payload',
    );
  });

  it('supports fast packed-snapshot hydration mode that skips recursive merges for already-present dependency trees', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export const z = "source";\n', 'utf8');
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'zod', 'v4', 'core.js'), 'export const core = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { zod: '4.3.6' },
      }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'export const packed = true;\n', 'utf8');

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('packed');
    expect(existsSync(join(snapshotDir, 'node_modules', 'zod', 'v4', 'core.js'))).toBe(false);
  });

  it('avoids copying nested node_modules trees wholesale in fast packed-snapshot mode', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-prune-node-modules-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', dependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'index.js'), 'module.exports = "dep-a";\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'),
      'module.exports = "nested-copy";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = "dep-b";\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-prune-node-modules-out-'));
    createdDirs.push(snapshotDir);
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(readFileSync(join(snapshotDir, 'node_modules', 'dep-a', 'index.js'), 'utf8')).toContain('dep-a');
    expect(readFileSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'), 'utf8')).toContain(
      'dep-b',
    );
  });

  it('keeps transitive dependency hydration enabled in fast packed-snapshot mode, including peer dependencies', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-transitive-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-transitive-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-a'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', peerDependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'))).toBe(true);
  });

  it('skips optional dependency hydration in fast packed-snapshot mode to avoid expensive cross-platform optional trees', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-optional-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required', 'package.json'),
      JSON.stringify({ name: 'dep-required', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-required', 'index.js'),
      'module.exports = "required";\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional', 'package.json'),
      JSON.stringify({ name: 'dep-optional', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-optional', 'index.js'),
      'module.exports = "optional";\n',
      'utf8',
    );

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-optional-out-'));
    createdDirs.push(snapshotDir);
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        version: '0.0.0-test',
        dependencies: { 'dep-required': '1.0.0' },
        optionalDependencies: { 'dep-optional': '1.0.0' },
      }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-required', 'index.js'))).toBe(true);
    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-optional', 'index.js'))).toBe(false);
  });

  it('limits fast packed-snapshot hydration to declared runtime graphs and skips unrelated tree-wide scans', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-scope-'));
    createdDirs.push(rootDir);
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b'), { recursive: true });
    mkdirSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'package.json'),
      JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-b', 'index.js'), 'module.exports = true;\n', 'utf8');
    writeFileSync(
      join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d', 'package.json'),
      JSON.stringify({ name: 'dep-d', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    );
    writeFileSync(join(rootDir, 'apps', 'cli', 'node_modules', 'dep-d', 'index.js'), 'module.exports = true;\n', 'utf8');

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-pack-snapshot-fast-scope-out-'));
    createdDirs.push(snapshotDir);
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-a'), { recursive: true });
    mkdirSync(join(snapshotDir, 'node_modules', 'dep-c'), { recursive: true });
    writeFileSync(
      join(snapshotDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0-test', dependencies: { 'dep-a': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-a', 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', peerDependencies: { 'dep-b': '1.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'node_modules', 'dep-c', 'package.json'),
      JSON.stringify({ name: 'dep-c', version: '1.0.0', dependencies: { 'dep-d': '1.0.0' } }, null, 2),
      'utf8',
    );

    ensureCliPackSnapshotRuntimeDependencies({ snapshotDir, rootDir, mergeExistingDirectories: false });

    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'index.js'))).toBe(true);
    expect(existsSync(join(snapshotDir, 'node_modules', 'dep-c', 'node_modules', 'dep-d', 'index.js'))).toBe(false);
  });
});



// Fixture repository whose CLI declares root-hoisted runtime dependencies. j078-direct needs the ROOT version of a name the
// CLI also carries locally (j078-cli-local@1 versus the CLI's @2) and its own nested j078-nested@3, while j078-transitive
// needs the root j078-nested@1; j078-direct and j078-transitive depend on each other.
function writeRuntimePackage(dir: string, manifest: Record<string, unknown>, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ main: 'index.js', ...manifest }));
  writeFileSync(resolve(dir, 'index.js'), body);
}
function createDeclaredRuntimeRoot(): string {
  const root = createRepoRoot();
  const modules = resolve(root, 'node_modules');
  writeFileSync(resolve(root, 'apps', 'cli', 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    dependencies: { 'j078-direct': '1', '@j078/scoped': '1', 'j078-cli-local': '2', 'j078-lazy': '1' },
    optionalDependencies: { 'j078-absent-optional': '1' },
  }));
  writeRuntimePackage(resolve(root, 'apps', 'cli', 'node_modules', 'j078-cli-local'), { name: 'j078-cli-local', version: '2.0.0' },
    "module.exports = 'cli-local@2';\n");
  writeRuntimePackage(resolve(modules, 'j078-cli-local'), { name: 'j078-cli-local', version: '1.0.0' }, "module.exports = 'cli-local@1';\n");
  writeRuntimePackage(resolve(modules, 'j078-direct'), {
    name: 'j078-direct', version: '1.0.0', dependencies: { 'j078-cli-local': '1', 'j078-transitive': '1', 'j078-nested': '3' },
  }, "module.exports = { direct: '1', cliLocal: require('j078-cli-local'), nested: require('j078-nested'), transitive: require('j078-transitive') };\n");
  writeRuntimePackage(resolve(modules, 'j078-direct', 'node_modules', 'j078-nested'), { name: 'j078-nested', version: '3.0.0' },
    "module.exports = 'nested@3';\n");
  writeRuntimePackage(resolve(modules, 'j078-nested'), { name: 'j078-nested', version: '1.0.0' }, "module.exports = 'nested@1';\n");
  writeRuntimePackage(resolve(modules, 'j078-transitive'), {
    name: 'j078-transitive', version: '1.0.0', dependencies: { 'j078-direct': '1', 'j078-nested': '1' },
  }, "module.exports = { name: 'transitive', nested: require('j078-nested') };\n");
  writeRuntimePackage(resolve(modules, '@j078', 'scoped'), { name: '@j078/scoped', version: '1.0.0' }, "module.exports = 'scoped';\n");
  writeRuntimePackage(resolve(modules, 'j078-lazy'), { name: 'j078-lazy', version: '1.0.0' }, "module.exports = 'lazy';\n");
  writeRuntimePackage(resolve(modules, 'j078-unrelated'), { name: 'j078-unrelated', version: '1.0.0' }, "module.exports = 'unrelated';\n");
  return root;
}
function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = resolve(entry.parentPath, entry.name); const stat = lstatSync(path);
    return `${path} ${stat.mode} ${stat.mtimeMs} ${entry.isFile() ? readFileSync(path, 'utf8') : ''}`;
  }).sort();
}

describe('J078 dist fallback declared runtime closure', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  // The retained generation is published through the real owner, outside the source root, and detached by it. It mirrors
  // the repository layout: the CLI package at apps/cli and the root runtime closure in the generation's node_modules.
  async function prepare(root: string): Promise<string> {
    const outside = mkdtempSync(join(tmpdir(), 'happier-cli-dist-fallback-'));
    dirs.push(root, outside);
    const generation = await createRetainedCliSnapshot({
      snapshotDir: resolve(outside, 'cli-dist-snapshot'),
      prepare: (payload) => {
        const cliDir = resolve(payload, 'apps', 'cli');
        mkdirSync(resolve(cliDir, 'dist'), { recursive: true });
        ensureCliDistSnapshotNodeModules({ snapshotDir: cliDir, rootMirrorDir: payload, rootDir: root });
      },
    });
    return resolve(generation, 'apps', 'cli', 'dist');
  }
  const rootClosureOf = (distDir: string) => resolve(distDir, '..', '..', '..', 'node_modules');
  it('J078 dist fallback loads placed packages at their source-tree versions after the source is removed', async () => {
    const root = createDeclaredRuntimeRoot();
    const fromSource = createRequire(resolve(root, 'apps', 'cli', 'dist', 'probe.cjs'));
    const names = ['j078-direct', '@j078/scoped', 'j078-cli-local', 'j078-lazy'];
    const expected = Object.fromEntries(names.map((name) => [name, fromSource(name)]));
    const distDir = await prepare(root);
    rmSync(root, { recursive: true, force: true });
    const fromGeneration = createRequire(resolve(distDir, 'probe.cjs'));
    expect(Object.fromEntries(names.map((name) => [name, fromGeneration(name)]))).toEqual(expected);
    expect(expected['j078-direct']).toEqual({
      direct: '1', cliLocal: 'cli-local@1', nested: 'nested@3', transitive: { name: 'transitive', nested: 'nested@1' },
    });
    // Dist's own import of a CLI-local name keeps the CLI's version.
    expect(expected['j078-cli-local']).toBe('cli-local@2');
  });
  it('J078 dist fallback omits root packages outside the declared runtime closure', async () => {
    const root = createDeclaredRuntimeRoot(); const distDir = await prepare(root);
    const closure = rootClosureOf(distDir);
    expect(readdirSync(closure).sort()).toEqual(['@j078', 'j078-cli-local', 'j078-direct', 'j078-lazy', 'j078-nested', 'j078-transitive']);
    expect(readdirSync(resolve(closure, '@j078'))).toEqual(['scoped']);
    // The root copy of a CLI-local name is reached by j078-direct and sits at the root position, behind the CLI's own;
    // a declared but never-imported dependency is still supplied. Nothing is placed among the dist chunks.
    expect(readFileSync(resolve(closure, 'j078-cli-local', 'index.js'), 'utf8')).toContain('cli-local@1');
    expect(readFileSync(resolve(distDir, '..', 'node_modules', 'j078-cli-local', 'index.js'), 'utf8')).toContain('cli-local@2');
    expect(readFileSync(resolve(closure, 'j078-lazy', 'index.js'), 'utf8')).toContain('lazy');
    expect(existsSync(resolve(distDir, 'node_modules'))).toBe(false);
  });
  it('J078 dist fallback links nothing without a CLI manifest', async () => {
    const root = createDeclaredRuntimeRoot(); rmSync(resolve(root, 'apps', 'cli', 'package.json'));
    const distDir = await prepare(root);
    expect(existsSync(rootClosureOf(distDir)) ? readdirSync(rootClosureOf(distDir)) : []).toEqual([]);
  });
  it('J078 dist fallback refuses a root mirror that does not contain the snapshot at the CLI package path', () => {
    const root = createDeclaredRuntimeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'happier-cli-dist-mirror-')); dirs.push(root, outside);
    for (const snapshotDir of [outside, resolve(outside, 'cli'), resolve(outside, 'apps', 'cli', 'dist'), resolve(outside, 'other', 'apps', 'cli')]) {
      expect(() => ensureCliDistSnapshotNodeModules({ snapshotDir, rootMirrorDir: outside, rootDir: root })).toThrow('is not the CLI package directory');
    }
    expect(readdirSync(outside)).toEqual([]);
  });
  it('J078 dist fallback recognizes placement descendants under each platform path semantics', () => {
    // The planner's boundary predicate must hold for native Windows paths (backslashes, drives, case), not only POSIX ones.
    const cases = [
      { api: win32, parent: 'C:\\fixture\\snapshot\\dist\\node_modules', inside: ['C:\\fixture\\snapshot\\dist\\node_modules\\axios',
        'C:\\fixture\\snapshot\\dist\\node_modules\\axios\\node_modules\\follow-redirects', 'c:\\FIXTURE\\snapshot\\dist\\node_modules\\@scope\\pkg'],
        outside: ['C:\\fixture\\snapshot\\dist\\node_modules', 'C:\\fixture\\snapshot\\dist\\node_modules2\\axios', 'C:\\fixture\\snapshot\\dist',
          'D:\\fixture\\snapshot\\dist\\node_modules\\axios'] },
      { api: posix, parent: '/fixture/snapshot/dist/node_modules', inside: ['/fixture/snapshot/dist/node_modules/axios',
        '/fixture/snapshot/dist/node_modules/axios/node_modules/follow-redirects', '/fixture/snapshot/dist/node_modules/@scope/pkg'],
        outside: ['/fixture/snapshot/dist/node_modules', '/fixture/snapshot/dist/node_modules2/axios', '/fixture/snapshot/dist', '/other/node_modules/axios'] },
    ];
    for (const { api, parent, inside, outside } of cases) {
      for (const path of inside) expect([path, isPathStrictlyInside(parent, path, api)]).toEqual([path, true]);
      for (const path of outside) expect([path, isPathStrictlyInside(parent, path, api)]).toEqual([path, false]);
    }
  });
  it('J078 dist fallback never writes into the live source tree', async () => {
    const root = createDeclaredRuntimeRoot();
    const before = [listTree(resolve(root, 'node_modules')), listTree(resolve(root, 'apps', 'cli', 'node_modules'))];
    await prepare(root);
    expect([listTree(resolve(root, 'node_modules')), listTree(resolve(root, 'apps', 'cli', 'node_modules'))]).toEqual(before);
  });
  // One registry module per package instance: a consumer can register a value and another read it back only when both
  // resolve to the same instance.
  const registry = (version: number) => 'const entries = new Map();\n'
    + `module.exports = { version: ${version}, put: (k, v) => entries.set(k, v), get: (k) => entries.get(k) ?? null };\n`;
  function addCliDependencies(root: string, dependencies: Record<string, string>): void {
    const manifestPath = resolve(root, 'apps', 'cli', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, ...dependencies } }));
  }
  it('J078 dist fallback shares one root package instance across dependents and keeps distinct instances distinct', async () => {
    // Root j078-entry depends on root j078-left and j078-right. Both reach the ROOT j078-state@1, while the CLI carries
    // its own j078-state@2. Both also use j078-tag@1: left reaches the root copy, right its own nested copy of the same
    // version. In the source tree left and right therefore share one j078-state instance and hold two j078-tag instances.
    const root = createDeclaredRuntimeRoot();
    const modules = resolve(root, 'node_modules');
    addCliDependencies(root, { 'j078-entry': '1', 'j078-state': '2' });
    writeRuntimePackage(resolve(root, 'apps', 'cli', 'node_modules', 'j078-state'), { name: 'j078-state', version: '2.0.0' }, registry(2));
    writeRuntimePackage(resolve(modules, 'j078-state'), { name: 'j078-state', version: '1.0.0' }, registry(1));
    writeRuntimePackage(resolve(modules, 'j078-tag'), { name: 'j078-tag', version: '1.0.0' }, registry(1));
    writeRuntimePackage(resolve(modules, 'j078-right', 'node_modules', 'j078-tag'), { name: 'j078-tag', version: '1.0.0' }, registry(1));
    const side = (name: string) => `module.exports = { name: '${name}', state: require('j078-state'), tag: require('j078-tag') };\n`;
    writeRuntimePackage(resolve(modules, 'j078-left'), { name: 'j078-left', version: '1.0.0', dependencies: { 'j078-state': '1', 'j078-tag': '1' } }, side('left'));
    writeRuntimePackage(resolve(modules, 'j078-right'), { name: 'j078-right', version: '1.0.0', dependencies: { 'j078-state': '1', 'j078-tag': '1' } }, side('right'));
    writeRuntimePackage(resolve(modules, 'j078-entry'), {
      name: 'j078-entry', version: '1.0.0', dependencies: { 'j078-left': '1', 'j078-right': '1' },
    }, "module.exports = { left: require('j078-left'), right: require('j078-right') };\n");
    // Source and generation live at distinct paths, so each probe loads its own module instances.
    const observe = (distDir: string) => {
      const load = createRequire(resolve(distDir, 'probe.cjs'));
      const { left, right } = load('j078-entry');
      const cliState = load('j078-state');
      left.state.put('key', 'via-left'); left.tag.put('key', 'via-left');
      return {
        versions: { left: left.state.version, right: right.state.version, cli: cliState.version, leftTag: left.tag.version, rightTag: right.tag.version },
        stateSharedWithRight: right.state.get('key'), stateSharedWithCli: cliState.get('key'), tagSharedWithRight: right.tag.get('key'),
      };
    };
    const expected = observe(resolve(root, 'apps', 'cli', 'dist'));
    expect(expected).toEqual({
      versions: { left: 1, right: 1, cli: 2, leftTag: 1, rightTag: 1 },
      stateSharedWithRight: 'via-left', stateSharedWithCli: null, tagSharedWithRight: null,
    });
    const distDir = await prepare(root);
    rmSync(root, { recursive: true, force: true });
    expect(observe(distDir)).toEqual(expected);
  });
  it('J078 dist fallback lets a CLI-local package share the root dependency instance root packages use', async () => {
    // The CLI's own j078-local-a and the root j078-root-c both depend on j078-root-b, which only the root provides.
    const root = createDeclaredRuntimeRoot();
    const modules = resolve(root, 'node_modules');
    addCliDependencies(root, { 'j078-local-a': '1', 'j078-root-c': '1' });
    writeRuntimePackage(resolve(modules, 'j078-root-b'), { name: 'j078-root-b', version: '1.0.0' }, registry(1));
    const user = (name: string) => `module.exports = { name: '${name}', b: require('j078-root-b') };\n`;
    writeRuntimePackage(resolve(root, 'apps', 'cli', 'node_modules', 'j078-local-a'),
      { name: 'j078-local-a', version: '1.0.0', dependencies: { 'j078-root-b': '1' } }, user('local-a'));
    writeRuntimePackage(resolve(modules, 'j078-root-c'), { name: 'j078-root-c', version: '1.0.0', dependencies: { 'j078-root-b': '1' } }, user('root-c'));
    const observe = (distDir: string) => {
      const load = createRequire(resolve(distDir, 'probe.cjs'));
      const a = load('j078-local-a'); const c = load('j078-root-c');
      a.b.put('key', 'via-local-a');
      return { versions: [a.b.version, c.b.version], sharedWithRootC: c.b.get('key') };
    };
    const expected = observe(resolve(root, 'apps', 'cli', 'dist'));
    expect(expected).toEqual({ versions: [1, 1], sharedWithRootC: 'via-local-a' });
    const distDir = await prepare(root);
    rmSync(root, { recursive: true, force: true });
    expect(observe(distDir)).toEqual(expected);
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
  const original = { read: fs.readFileSync, cpSync: fs.cpSync, openSync: fs.openSync, cp: promises.cp, rename: promises.rename, kill: process.kill, fetch: globalThis.fetch,
    child: Object.fromEntries(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].map((key) => [key, cp[key]])),
    httpRequest: http.request, httpsRequest: https.request, httpServer: http.createServer, netServer: net.createServer };
  const state = { active: true, attempts: [] as string[], onCopy: null as null | ((src: string, dest: string, run: () => Promise<void>) => Promise<void>),
    onRename: null as null | ((src: string, dest: string, run: () => Promise<void>) => Promise<void>) };
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
  // The snapshot copier writes files through openSync (no copy_file_range), so bound its write/create opens to TMPDIR too.
  // Read-only opens are exempt: readFileSync internals and module loading also route through fs.openSync.
  const isWriteOpen = (flags: unknown) => typeof flags === 'string'
    ? /[wa+]/.test(flags)
    : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
      | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
  fs.openSync = (...args: unknown[]) => { if (state.active && isWriteOpen(args[1])) allowed(args[0]); return original.openSync(...args); };
  promises.cp = async (src: string, dest: string, ...args: unknown[]) => {
    if (state.active) { allowed(src); allowed(dest); }
    const run = () => original.cp(src, dest, ...args) as Promise<void>;
    return state.active && state.onCopy ? state.onCopy(src, dest, run) : run();
  };
  // Retained snapshots are published by rename, so bound its source and destination to TMPDIR too.
  promises.rename = async (src: string, dest: string) => {
    if (state.active) { allowed(dest); allowed(src); }
    const run = () => original.rename(src, dest) as Promise<void>;
    return state.active && state.onRename ? state.onRename(src, dest, run) : run();
  };
  syncBuiltinESMExports();
  if ((await import('node:child_process')).spawnSync !== cp.spawnSync
    || (await import('node:fs')).readFileSync !== fs.readFileSync
    || (await import('node:fs')).openSync !== fs.openSync
    || (await import('node:fs/promises')).cp !== promises.cp
    || (await import('node:fs/promises')).rename !== promises.rename) throw new Error('J078 actual builtin binding mismatch');
  return { state, restore: () => {
    fs.readFileSync = original.read; fs.cpSync = original.cpSync; fs.openSync = original.openSync; promises.cp = original.cp; promises.rename = original.rename;
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

describe('J078 detached lazy runtime closure', () => {
  // The ownership-bearing final allocation: the publication destination's enclosing allocation when the destination
  // is <allocation>/<basename(allocation)>, else the destination itself (layouts that publish onto the allocation).
  const allocationOf = (dest: string) => (basename(dest) === basename(dirname(dest)) ? dirname(dest) : dest);
  const roots: string[] = [];
  afterEach(() => { j078Boundary.state.onCopy = null; j078Boundary.state.onRename = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  async function launchFixture(mode: 'copy' | 'symlink' = 'copy') {
    const root = createRepoRoot(); roots.push(root);
    mkdirSync(resolve(root, 'apps', 'cli', 'src'), { recursive: true });
    mkdirSync(resolve(root, 'apps', 'cli', 'tools'), { recursive: true });
    writeFileSync(resolve(root, 'apps', 'cli', 'src', 'index.ts'), 'export {};');
    writeFileSync(resolve(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}');
    writeFileSync(resolve(root, 'apps', 'cli', 'tsconfig.json'), '{}');
    const { resolveCliTestLaunchSpec } = await import('./cliLaunchSpec');
    const launch = () => resolveCliTestLaunchSpec({ testDir: root, env: {
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: mode,
    } }, { repoRoot: root, snapshotDir: resolve(root, 'cli-source-snapshot') });
    return { root, launch };
  }
  it.each(['copy', 'symlink'] as const)('J078 retains lazy runtime files selected in %s mode', async (mode) => {
    const f = await launchFixture(mode); const spec = await f.launch();
    const lazy = resolve(spec.cwd!, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js');
    const before = readFileSync(lazy, 'utf8');
    rmSync(resolve(f.root, 'apps', 'cli', 'node_modules'), { recursive: true });
    expect(readFileSync(lazy, 'utf8')).toBe(before);
    expect(lstatSync(resolve(spec.cwd!, 'src')).isSymbolicLink()).toBe(false);
  });
  it('J078 does not detach hoisted root packages into an unreachable source-generation dist fallback', async () => {
    const f = await launchFixture('copy');
    mkdirSync(resolve(f.root, 'node_modules', 'hoisted-only'), { recursive: true });
    writeFileSync(resolve(f.root, 'node_modules', 'hoisted-only', 'index.js'), 'module.exports = "root";');
    const spec = await f.launch();
    expect(existsSync(resolve(spec.cwd!, 'dist', 'node_modules', 'hoisted-only'))).toBe(false);
    expect(readFileSync(resolve(spec.cwd!, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'hmac.js'), 'utf8'))
      .toContain('initial');
  });
  it('J078 hydrates linked runtime entries as detached regular files that keep their mode', () => {
    const rootDir = createRepoRoot();
    const linkedSource = resolve(rootDir, 'packages', 'linked-runtime');
    mkdirSync(linkedSource, { recursive: true });
    writeFileSync(resolve(linkedSource, 'cli.js'), 'export const value = "initial";\n', { mode: 0o755 });
    chmodSync(resolve(linkedSource, 'cli.js'), 0o755);
    symlinkSync(linkedSource, resolve(rootDir, 'apps', 'cli', 'node_modules', 'linked-runtime'));
    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-bytes-'));
    roots.push(rootDir, snapshotDir);

    ensureCliDistSnapshotNodeModules({ snapshotDir, rootDir });

    const copiedDir = resolve(snapshotDir, 'node_modules', 'linked-runtime');
    const copiedFile = resolve(copiedDir, 'cli.js');
    // linked-runtime is reached through a symlink, so the dereferencing copier materializes it; plain-directory
    // merging in copyMissingEntry is intentionally unchanged R13 behavior (no mode/timestamp copy).
    expect(lstatSync(copiedDir).isDirectory()).toBe(true);
    expect(lstatSync(copiedDir).mode & 0o777).toBe(lstatSync(linkedSource).mode & 0o777);
    // utimes takes Date (millisecond) values, as cpSync's preserveTimestamps did.
    expect(Math.abs(lstatSync(copiedDir).mtimeMs - lstatSync(linkedSource).mtimeMs)).toBeLessThan(1);
    expect(lstatSync(copiedFile).isFile()).toBe(true);
    expect(lstatSync(copiedFile).mode & 0o777).toBe(0o755);
    expect(lstatSync(copiedFile).ino).not.toBe(lstatSync(resolve(linkedSource, 'cli.js')).ino);
    writeFileSync(resolve(linkedSource, 'cli.js'), 'export const value = "mutated";\n');
    expect(readFileSync(copiedFile, 'utf8')).toContain('initial');
  });
  it('J078 refuses hydrated runtime copies outside the owned TMPDIR', () => {
    const rootDir = createRepoRoot();
    const linkedSource = resolve(rootDir, 'packages', 'linked-runtime');
    mkdirSync(linkedSource, { recursive: true });
    writeFileSync(resolve(linkedSource, 'cli.js'), 'export {};\n');
    symlinkSync(linkedSource, resolve(rootDir, 'apps', 'cli', 'node_modules', 'linked-runtime'));
    const outside = resolve(process.cwd(), '.project', 'tmp', `j078-outside-tmpdir-${process.pid}-${Date.now()}`);
    try {
      ensureCliDistSnapshotNodeModules({ snapshotDir: outside, rootDir });
      expect(existsSync(resolve(outside, 'node_modules', 'linked-runtime', 'cli.js'))).toBe(false);
      // Read-only opens outside TMPDIR (module loading, readFileSync internals) stay unbounded.
      closeSync(openSync(resolve(process.cwd(), 'package.json'), 'r'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
      roots.push(rootDir);
    }
  });
  it.each(['copy', 'symlink'] as const)('J078 returns a generation tree without symbolic links in %s mode', async (mode) => {
    const f = await launchFixture(mode); const spec = await f.launch();
    const links: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) links.push(path); else if (entry.isDirectory()) walk(path);
      }
    };
    expect(lstatSync(spec.cwd!).isSymbolicLink()).toBe(false);
    walk(spec.cwd!);
    expect(links).toEqual([]);
    expect(existsSync(resolve(spec.cwd!, 'src', 'index.ts'))).toBe(true);
  });
  it('J078 refuses a publication rename outside the owned TMPDIR', async () => {
    const outside = resolve(process.cwd(), '.project', 'tmp', `j078-outside-tmpdir-rename-${process.pid}-${Date.now()}`);
    try {
      await expect(createRetainedCliSnapshot({
        snapshotDir: resolve(outside, 'cli-source-snapshot'),
        prepare: (payload) => { mkdirSync(resolve(payload, 'src'), { recursive: true }); },
      })).rejects.toThrow(/outside owned TMPDIR: .*cli-source-snapshot-generation-/);
      // Nothing is published, and both unpublished allocations are cleaned as before.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('J078 refuses required dangling scaffolding instead of publishing a live link', async () => {
    const f = await launchFixture();
    symlinkSync(resolve(f.root, 'not-present'), resolve(f.root, 'apps', 'cli', 'tools', 'dangling'));
    await expect(f.launch()).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('J078 refuses cyclic runtime links instead of publishing a partial generation', async () => {
    const f = await launchFixture('symlink');
    symlinkSync('cycle', resolve(f.root, 'apps', 'cli', 'node_modules', 'cycle'));
    await expect(f.launch()).rejects.toThrow();
  });
  it('J078 refuses a replaced final allocation even after copy succeeds', async () => {
    const f = await launchFixture(); let replacement = '';
    j078Boundary.state.onRename = async (_src, dest, run) => {
      await run(); replacement = dest;
      const fs = await import('node:fs');
      fs.renameSync(dest, `${dest}-original`); fs.mkdirSync(dest);
      fs.writeFileSync(resolve(dest, 'replacement'), 'unrelated fixture owner');
    };
    await expect(f.launch()).rejects.toThrow('allocation replaced before return');
    expect(readFileSync(resolve(replacement, 'replacement'), 'utf8')).toBe('unrelated fixture owner');
  });
  it('J078 preserves a replacement final allocation when materialization fails', async () => {
    const f = await launchFixture(); let replacement = '';
    j078Boundary.state.onRename = async (_src, dest, _run) => {
      if (!dest.includes('-generation-')) throw new Error('fixture expected final generation');
      replacement = allocationOf(dest);
      const fs = await import('node:fs');
      fs.renameSync(replacement, `${replacement}-original`); fs.mkdirSync(replacement);
      fs.writeFileSync(resolve(replacement, 'replacement'), 'unrelated fixture owner');
      throw new Error('fixture materialization rejected');
    };
    await expect(f.launch()).rejects.toThrow('fixture materialization rejected');
    expect(readFileSync(resolve(replacement, 'replacement'), 'utf8')).toBe('unrelated fixture owner');
  });
  it('J078 refuses a final allocation replaced after publication and preserves the replacement', async () => {
    const f = await launchFixture(); let replacement = '';
    j078Boundary.state.onRename = async (_src, dest, run) => {
      await run(); replacement = allocationOf(dest);
      const fs = await import('node:fs');
      fs.renameSync(replacement, `${replacement}-original`); fs.mkdirSync(replacement);
      fs.writeFileSync(resolve(replacement, 'replacement'), 'unrelated fixture owner');
    };
    await expect(f.launch()).rejects.toThrow('allocation replaced before return');
    expect(readdirSync(replacement)).toEqual(['replacement']);
    expect(readFileSync(resolve(replacement, 'replacement'), 'utf8')).toBe('unrelated fixture owner');
  });
  it('J078 refuses a final allocation replaced before publication without replacing its successor', async () => {
    const f = await launchFixture(); let successor = ''; let successorIdentity = { dev: -1, ino: -1 };
    j078Boundary.state.onRename = async (_src, dest, run) => {
      if (!dest.includes('-generation-')) throw new Error('fixture expected final generation');
      successor = allocationOf(dest);
      const fs = await import('node:fs');
      fs.renameSync(successor, `${successor}-original`); fs.mkdirSync(successor);
      const { dev, ino } = fs.lstatSync(successor); successorIdentity = { dev, ino };
      await run();
    };
    await expect(f.launch()).rejects.toThrow('allocation replaced before return');
    const { dev, ino } = lstatSync(successor);
    expect({ dev, ino }).toEqual(successorIdentity);
    // The payload that landed inside the successor is taken back; the successor itself is left as it was installed.
    expect(readdirSync(successor)).toEqual([]);
  });
  it('J078 publishes without renaming onto an existing directory', async () => {
    const f = await launchFixture(); const destinations: string[] = [];
    j078Boundary.state.onRename = async (_src, dest, run) => {
      destinations.push(dest);
      // Model only the documented Windows MoveFileExW refusal of an existing directory destination (not a native run).
      if (existsSync(dest) && lstatSync(dest).isDirectory()) {
        throw Object.assign(new Error(`rename onto an existing directory: ${dest}`), { code: 'EPERM' });
      }
      await run();
    };
    const spec = await f.launch();
    expect(destinations).toEqual([spec.cwd]);
    expect(existsSync(resolve(spec.cwd!, 'src', 'index.ts'))).toBe(true);
  });
  it('J078 retains a foreign entry at the publication slot and the allocation that holds it', async () => {
    const f = await launchFixture(); let slot = '';
    j078Boundary.state.onRename = async (_src, dest, run) => {
      if (!dest.includes('-generation-')) throw new Error('fixture expected final generation');
      slot = resolve(allocationOf(dest), basename(allocationOf(dest)));
      const fs = await import('node:fs');
      fs.mkdirSync(slot); fs.writeFileSync(resolve(slot, 'foreign'), 'unrelated fixture owner');
      await run();
    };
    await expect(f.launch()).rejects.toThrow();
    expect(readdirSync(slot)).toEqual(['foreign']);
    expect(readFileSync(resolve(slot, 'foreign'), 'utf8')).toBe('unrelated fixture owner');
  });
  it('J078 retains a successor allocation and the foreign entry inside it', async () => {
    const f = await launchFixture(); let successor = ''; let slot = ''; let successorIdentity = { dev: -1, ino: -1 };
    j078Boundary.state.onRename = async (_src, dest, run) => {
      if (!dest.includes('-generation-')) throw new Error('fixture expected final generation');
      successor = allocationOf(dest); slot = resolve(successor, basename(successor));
      const fs = await import('node:fs');
      fs.renameSync(successor, `${successor}-original`); fs.mkdirSync(successor);
      const { dev, ino } = fs.lstatSync(successor); successorIdentity = { dev, ino };
      fs.mkdirSync(slot); fs.writeFileSync(resolve(slot, 'foreign'), 'unrelated fixture owner');
      await run();
    };
    await expect(f.launch()).rejects.toThrow();
    const { dev, ino } = lstatSync(successor);
    expect({ dev, ino }).toEqual(successorIdentity);
    expect(readdirSync(successor)).toEqual([basename(slot)]);
    expect(readFileSync(resolve(slot, 'foreign'), 'utf8')).toBe('unrelated fixture owner');
  });
});
