import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const config = vi.hoisted(() => ({ happyHomeDir: '' }));
vi.mock('@/configuration', () => ({ configuration: config }));

let tempDir: string | null = null;
afterEach(async () => {
  if (tempDir) await removeTempDir(tempDir);
  tempDir = null;
});

it('normalizes a legacy cached Codex mode before a resumed session consumes it', async () => {
  tempDir = await createTempDir('happier-startup-overrides-');
  config.happyHomeDir = tempDir;
  const cacheDir = join(tempDir, 'cli');
  await mkdir(cacheDir);
  await writeFile(join(cacheDir, 'startup-overrides-cache.json'), JSON.stringify({
    version: 1,
    byBackend: {
      codex: {
        permissionMode: 'acceptEdits',
        permissionModeUpdatedAt: 100,
        modelId: null,
        modelUpdatedAt: 0,
        updatedAt: 100,
      },
    },
  }));

  vi.resetModules();
  const { readStartupOverridesCacheForBackend } = await import('./startupOverridesCache');
  expect(readStartupOverridesCacheForBackend({ backendId: 'codex', nowMs: 100, maxAgeMs: 1000 }))
    .toMatchObject({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 100 });
});
