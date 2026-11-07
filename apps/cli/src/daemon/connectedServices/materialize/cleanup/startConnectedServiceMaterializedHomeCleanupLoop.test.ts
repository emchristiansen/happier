import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { waitForCondition } from '@/testkit/async/waitFor';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from './ConnectedServiceMaterializedHomeCleanupScheduler';
import { startConnectedServiceMaterializedHomeCleanupLoop } from './startConnectedServiceMaterializedHomeCleanupLoop';

async function touchOld(path: string, nowMs: number, ageMs: number): Promise<void> {
  const time = new Date(nowMs - ageMs);
  await utimes(path, time, time);
}

describe('startConnectedServiceMaterializedHomeCleanupLoop', () => {
  it('triggers the real materialized-home scheduler to retire stale orphan credentials while retaining history', async () => {
    const baseDir = await createTempDir('happier-materialized-cleanup-loop-');
    const nowMs = 100_000;
    try {
      const staleHome = join(baseDir, 'csm_stale', 'codex');
      const retainedHome = join(baseDir, 'csm_retained', 'codex');
      for (const home of [staleHome, retainedHome]) {
        await mkdir(join(home, 'codex-home', 'sessions'), { recursive: true });
        await writeFile(join(home, 'codex-home', 'sessions', 'session.jsonl'), `history ${home}\n`);
        await writeFile(join(home, 'codex-home', 'auth.json'), 'synthetic credential');
      }
      await touchOld(staleHome, nowMs, 60_000);
      await touchOld(retainedHome, nowMs, 60_000);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => false,
        listRetainedIdentityIds: () => new Set(['csm_retained']),
      });
      const errors: unknown[] = [];
      const loop = startConnectedServiceMaterializedHomeCleanupLoop({
        enabled: true,
        tickMs: 60_000,
        scheduler,
        onTickError: (error) => {
          errors.push(error);
        },
      });

      try {
        expect(loop).not.toBeNull();
        loop?.trigger();

        await waitForCondition(async () => {
          try {
            await stat(join(staleHome, 'codex-home', 'auth.json'));
            return false;
          } catch (error) {
            return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
          }
        }, {
          timeoutMs: 2_000,
          intervalMs: 20,
          label: 'stale materialized home credential retirement',
        });

        await expect(readFile(join(staleHome, 'codex-home', 'sessions', 'session.jsonl'), 'utf8')).resolves.toBe(`history ${staleHome}\n`);
        await expect(readFile(join(retainedHome, 'codex-home', 'auth.json'), 'utf8')).resolves.toBe('synthetic credential');
        await expect(readFile(join(retainedHome, 'codex-home', 'sessions', 'session.jsonl'), 'utf8')).resolves.toBe(`history ${retainedHome}\n`);
        expect(errors).toEqual([]);
      } finally {
        loop?.stop();
      }
    } finally {
      await removeTempDir(baseDir);
    }
  });
});
