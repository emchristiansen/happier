import { atomicReplaceDirSync, bundleInstalledPackageWithRuntimeDependencies, bundleWorkspacePackage, copyDirSafeSync, vendorBundledPackageRuntimeDependencies } from './index';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

describe('bundleWorkspacePackage', () => {
  let rootDir: string | undefined;
  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('preserves conditional package imports and their package-root runtime targets', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'workspace-package-imports-'));
    const sourceDir = resolve(rootDir, 'packages', 'fixture');
    const destinationDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', 'fixture');
    const imports = {
      '#http': { node: './runtime/node.js', default: './dist/fetch.js' },
      '#fs': 'fs',
      '#disabled': null,
    };
    mkdirSync(resolve(sourceDir, 'dist'), { recursive: true });
    mkdirSync(resolve(sourceDir, 'runtime'), { recursive: true });
    writeFileSync(resolve(sourceDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/fixture', version: '0.0.0', type: 'module',
      exports: { '.': './dist/connect.js' }, imports,
    }));
    writeFileSync(resolve(sourceDir, 'dist/connect.js'), 'import { transport } from "#http"; import { existsSync } from "#fs"; export const selected = transport + ":" + typeof existsSync;\n');
    writeFileSync(resolve(sourceDir, 'dist/fetch.js'), 'export const transport = "fetch";\n');
    writeFileSync(resolve(sourceDir, 'runtime/node.js'), 'export const transport = "node";\n');
    bundleWorkspacePackage({ packageName: '@happier-dev/fixture', srcDir: sourceDir, destDir: destinationDir });
    // Real Node resolution observes the bundled manifest, not Vitest's resolver.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const module = await import(${JSON.stringify(pathToFileURL(resolve(destinationDir, 'dist/connect.js')).href)}); console.log(module.selected);`,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('node:function');
    expect(JSON.parse(readFileSync(resolve(destinationDir, 'package.json'), 'utf8')).imports).toEqual(imports);
    expect(readFileSync(resolve(destinationDir, 'dist/fetch.js'), 'utf8')).toContain('fetch');
  });

  it('removes legacy dist staging dirs when rebundling into an existing destination', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    const legacyTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.old-staging');
    const legacyBackupDir = resolve(destPackageDir, 'dist.__sync_backup__.old-staging');
    mkdirSync(legacyTmpDir, { recursive: true });
    mkdirSync(legacyBackupDir, { recursive: true });

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(() => readdirSync(legacyTmpDir)).toThrow();
    expect(() => readdirSync(legacyBackupDir)).toThrow();

    const destPackageJsonPath = resolve(destPackageDir, 'package.json');
    const destPackageJson = JSON.parse(readFileSync(destPackageJsonPath, 'utf8'));
    expect(destPackageJson).toEqual(
      expect.objectContaining({
        name: '@happier-dev/protocol',
        private: true,
        exports: { '.': { default: './dist/index.js' } },
      }),
    );

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');

    const destParent = resolve(destPackageDir, '..');
    const siblingNames = readdirSync(destParent);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_tmp__.'))).toBe(false);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_backup__.'))).toBe(false);
  });

  it('bundles external runtime dependencies inside the same workspace replacement', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const zodPackageDir = resolve(srcPackageDir, 'node_modules/zod');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(resolve(zodPackageDir, 'v4/core'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', type: 'module', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'v4/core/schemas.js'), 'export const schemas = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');
    expect(readFileSync(resolve(destPackageDir, 'node_modules/zod/v4/core/schemas.js'), 'utf8')).toBe(
      'export const schemas = {};\n',
    );
  });

  it('copies non-dist package export targets so the bundled public surface remains loadable', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/cli-common');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            './workspaceLockLease': { default: './workspaceLockLease.mjs' },
            './workspaceBundleLock': { default: './workspaceBundleLock.mjs' },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};\n');
    writeFileSync(resolve(srcPackageDir, 'workspaceLockLease.mjs'), 'export const lease = "canonical";\n');
    writeFileSync(
      resolve(srcPackageDir, 'workspaceBundleLock.mjs'),
      'export { lease } from "./workspaceLockLease.mjs";\n',
    );

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/cli-common');
    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'workspaceBundleLock.mjs'), 'utf8')).toContain(
      './workspaceLockLease.mjs',
    );
    expect(readFileSync(resolve(destPackageDir, 'workspaceLockLease.mjs'), 'utf8')).toContain('canonical');
  });
});

describe('Transformers runtime dependency closure', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  });

  it.each(['host', 'installed'] as const)('keeps the isolated Node import and distinct Web runtime loadable through %s vendoring', (kind) => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-transformers-closure-'));
    const sourceDir = join(rootDir, 'source');
    const payloadDir = join(rootDir, 'payload');
    const writePackage = (packageDir: string, name: string, version: string, code: string, dependencies: Record<string, string> = {}) => {
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './index.js', dependencies }));
      writeFileSync(join(packageDir, 'index.js'), code);
    };

    writePackage(sourceDir, 'host', '1.0.0', '', { '@huggingface/transformers': '3.8.1' });
    const transformersDir = join(sourceDir, 'node_modules', '@huggingface', 'transformers');
    // Mirrors 3.8.1's distributed Node import and manifest: Common is imported directly,
    // but is only declared by the Node/Web runtimes, which require different versions.
    writePackage(transformersDir, '@huggingface/transformers', '3.8.1',
      'import { version as direct } from "onnxruntime-common"; import { version as node } from "onnxruntime-node"; import { version as web } from "onnxruntime-web"; export const versions = { direct, node, web };',
      { 'onnxruntime-node': '1.21.0', 'onnxruntime-web': '1.22.0-dev.20250409-89f8206ba4' });
    for (const [runtime, version] of [['node', '1.21.0'], ['web', '1.22.0-dev.20250409-89f8206ba4']]) {
      const runtimeDir = join(sourceDir, 'node_modules', `onnxruntime-${runtime}`);
      writePackage(runtimeDir, `onnxruntime-${runtime}`, version, 'export { version } from "onnxruntime-common";', { 'onnxruntime-common': version });
      writePackage(join(runtimeDir, 'node_modules', 'onnxruntime-common'), 'onnxruntime-common', version, `export const version = ${JSON.stringify(version)};`);
    }

    if (kind === 'host') {
      vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath: join(sourceDir, 'package.json'), destPackageDir: payloadDir });
    } else {
      bundleInstalledPackageWithRuntimeDependencies({ packageName: '@huggingface/transformers', resolveFromPackageJsonPath: join(sourceDir, 'package.json'), destNodeModulesDir: join(payloadDir, 'node_modules') });
    }
    const moduleUrl = pathToFileURL(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'index.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'console.log(JSON.stringify((await import(process.argv[1])).versions))', moduleUrl], { encoding: 'utf8', cwd: payloadDir });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ direct: '1.21.0', node: '1.21.0', web: '1.22.0-dev.20250409-89f8206ba4' });
  });
});

describe('explicitly supplied root runtime dependencies', () => {
  it('omits only the host dependency while preserving transitive consumers and default vendoring', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-runtime-root-omission-'));
    try {
      const sourceDir = join(rootDir, 'source');
      const writePackage = (directory: string, name: string, code: string, dependencies: Record<string, string>) => {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', dependencies }));
        writeFileSync(join(directory, 'index.cjs'), code);
      };
      writePackage(sourceDir, 'host', '', { 'optional-runtime': '1.0.0', consumer: '1.0.0' });
      writePackage(join(sourceDir, 'node_modules/optional-runtime'), 'optional-runtime', 'module.exports = "runtime-loaded";', {});
      writePackage(join(sourceDir, 'node_modules/consumer'), 'consumer', 'module.exports = require("optional-runtime");', { 'optional-runtime': '1.0.0' });

      const payloadDir = join(rootDir, 'payload');
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: join(sourceDir, 'package.json'),
        destPackageDir: payloadDir,
        excludeRootDependencies: ['optional-runtime'],
      });
      expect(existsSync(join(payloadDir, 'node_modules/optional-runtime'))).toBe(false);
      expect(createRequire(join(payloadDir, 'package.json'))('consumer')).toBe('runtime-loaded');

      const defaultPayloadDir = join(rootDir, 'default-payload');
      vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath: join(sourceDir, 'package.json'), destPackageDir: defaultPayloadDir });
      expect(createRequire(join(defaultPayloadDir, 'package.json'))('optional-runtime')).toBe('runtime-loaded');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('atomicReplaceDirSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a staged swap when the destination briefly reappears during the rename', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let renameFailures = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === stagedDir && target === destDir && renameFailures === 0) {
            renameFailures += 1;
            const error = new Error('ENOTEMPTY');
            Reflect.set(error, 'code', 'ENOTEMPTY');
            throw error;
          }

          return renameSync(source, target);
        },
      },
    });

    expect(renameFailures).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('continues when the destination disappears after the existence check', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let existsChecks = 0;
    let renameCalls = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        existsSync(targetPath) {
          if (targetPath === destDir) {
            existsChecks += 1;
            return existsChecks === 1 ? true : existsSync(targetPath);
          }
          return existsSync(targetPath);
        },
        renameSync(source, target) {
          if (source === destDir && target !== destDir && renameCalls === 0) {
            renameCalls += 1;
            rmSync(destDir, { recursive: true, force: true });
            const error = new Error('ENOENT');
            Reflect.set(error, 'code', 'ENOENT');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    });

    expect(renameCalls).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('does not remove the live destination when backup rename is blocked', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';

    expect(() => atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, 'next.txt'), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === destDir && target !== destDir) {
            const error = new Error('EPERM');
            Reflect.set(error, 'code', 'EPERM');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    })).toThrow(/EPERM/);

    expect(existsSync(stagedDir)).toBe(false);
    expect(readFileSync(resolve(destDir, previousFileName), 'utf8')).toBe('old');
  });
});

describe('copyDirSafeSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a transient ENOENT while copying a directory tree', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-copy-dir-'));

    const srcDir = resolve(rootDir, 'packages/protocol/dist');
    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/dist');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(resolve(srcDir, 'index.js'), 'export const ok = true;\n');

    let attempts = 0;

    copyDirSafeSync(srcDir, destDir, {
      retries: 1,
      delayMs: 0,
      cpSyncImpl(source, target, options) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('ENOENT');
          Reflect.set(error, 'code', 'ENOENT');
          throw error;
        }

        return cpSync(source, target, options);
      },
    });

    expect(attempts).toBe(2);
    expect(readFileSync(resolve(destDir, 'index.js'), 'utf8')).toBe('export const ok = true;\n');
  });
});
