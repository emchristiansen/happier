import { afterAll as j078AfterAll, beforeEach as j078BeforeEach } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureCliDistSnapshotNodeModules, ensureCliPackSnapshotRuntimeDependencies } from './cliDistSnapshotNodeModules';

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
    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    const snapshotDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-snapshot-direct-deps-out-'));
    createdDirs.push(snapshotDir);
    const snapshotDistDir = resolve(snapshotDir, 'dist');
    mkdirSync(snapshotDistDir, { recursive: true });

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

    ensureCliDistSnapshotNodeModules({ snapshotDir, snapshotDistDir, rootDir });

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

describe('J078 detached lazy runtime closure', () => {
  const roots: string[] = [];
  afterEach(() => { j078Boundary.state.onCopy = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
    j078Boundary.state.onCopy = async (_src, dest, run) => {
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
    j078Boundary.state.onCopy = async (_src, dest, _run) => {
      if (!dest.includes('-generation-')) throw new Error('fixture expected final generation');
      replacement = dest;
      const fs = await import('node:fs');
      fs.renameSync(dest, `${dest}-original`); fs.mkdirSync(dest);
      fs.writeFileSync(resolve(dest, 'replacement'), 'unrelated fixture owner');
      throw new Error('fixture materialization rejected');
    };
    await expect(f.launch()).rejects.toThrow('fixture materialization rejected');
    expect(readFileSync(resolve(replacement, 'replacement'), 'utf8')).toBe('unrelated fixture owner');
  });
});
