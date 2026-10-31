import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';

const require = createRequire(import.meta.url);

describe('fixNodePtySpawnHelperPermissions', () => {
  it('restores executable permissions for bundled node-pty spawn helpers', () => {
    if (process.platform === 'win32') return;

    const root = createTempDirSync('happier-node-pty-permissions-');
    try {
      // Load current source through the published package boundary, without using
      // a possibly stale workspace bundle in apps/cli/node_modules.
      const commonDir = join(root, 'node_modules', '@happier-dev', 'cli-common');
      mkdirSync(commonDir, { recursive: true });
      for (const name of ['package.json', 'nodePtySpawnHelperPermissions.cjs']) {
        copyFileSync(new URL(`../../../../packages/cli-common/${name}`, import.meta.url), join(commonDir, name));
      }
      const scriptPath = join(root, 'fix-node-pty-spawn-helper-permissions.cjs');
      copyFileSync(new URL('./fix-node-pty-spawn-helper-permissions.cjs', import.meta.url), scriptPath);
      const { fixNodePtySpawnHelperPermissions } = require(scriptPath) as {
        fixNodePtySpawnHelperPermissions: (options?: { cwd?: string }) => { fixed: number; paths: string[] };
      };
      const helperPaths = [
        join(root, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
        join(root, 'node_modules', 'node-pty', 'build', 'Debug', 'spawn-helper'),
        join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
        join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
        join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'spawn-helper'),
      ];

      for (const helperPath of helperPaths) {
        mkdirSync(join(helperPath, '..'), { recursive: true });
        writeFileSync(helperPath, '#!/usr/bin/env node\n', 'utf8');
        chmodSync(helperPath, 0o644);
      }

      const result = fixNodePtySpawnHelperPermissions({ cwd: root });
      expect(result.fixed).toBe(helperPaths.length);

      for (const helperPath of helperPaths) {
        const mode = statSync(helperPath).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    } finally {
      removeTempDirSync(root);
    }
  });
});
