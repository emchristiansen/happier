import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCachedCliUpdateState, recordCliUpdateCheck, resolveCliUpdateCachePath } from './index.js';

describe('CLI update-check cache (one reader, one writer)', () => {
  let homeDir = '';
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-cache-'));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('keeps one cache per ring and never records another ring\'s version as latest', async () => {
    expect(resolveCliUpdateCachePath({ homeDir, publicReleaseRing: 'stable' })).toBe(join(homeDir, 'cache', 'update.json'));
    expect(resolveCliUpdateCachePath({ homeDir, publicReleaseRing: 'publicdev' })).toBe(join(homeDir, 'cache', 'update.dev.json'));

    // preview and dev share npm's `next` dist-tag: a dev build must not become preview's latest.
    recordCliUpdateCheck({
      homeDir,
      publicReleaseRing: 'preview',
      latest: '0.2.20-dev.4',
      current: '0.2.13-preview.2',
      runtimeVersion: null,
      invokerVersion: '0.2.13-preview.2',
      nowMs: 1_000,
    });
    const cached = JSON.parse(await readFile(resolveCliUpdateCachePath({ homeDir, publicReleaseRing: 'preview' }), 'utf8'));
    expect(cached).toMatchObject({ checkedAt: 1_000, latest: null, updateAvailable: false });
  });

  it('compares the ring\'s latest with the version actually running, and preserves the notice time', async () => {
    const cachePath = resolveCliUpdateCachePath({ homeDir, publicReleaseRing: 'stable' });
    await mkdir(join(homeDir, 'cache'), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ checkedAt: 1, latest: '0.2.12', notifiedAt: 77 }));

    recordCliUpdateCheck({
      homeDir,
      publicReleaseRing: 'stable',
      latest: '0.2.14',
      current: '0.2.13',
      runtimeVersion: null,
      invokerVersion: '0.2.13',
      nowMs: 2_000,
    });
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({ latest: '0.2.14', updateAvailable: true, notifiedAt: 77 });

    expect(readCachedCliUpdateState({ homeDir, publicReleaseRing: 'stable', currentVersion: '0.2.13' }))
      .toEqual({ currentVersion: '0.2.13', latestVersion: '0.2.14', updateAvailable: true, checkedAt: 2_000 });
    // Updated since the check: no update is reported even though the cache said so.
    expect(readCachedCliUpdateState({ homeDir, publicReleaseRing: 'stable', currentVersion: '0.2.14' }))
      .toMatchObject({ latestVersion: '0.2.14', updateAvailable: false });
  });

  it('reads a cache an older writer filled with another ring\'s version as unknown', async () => {
    const cachePath = resolveCliUpdateCachePath({ homeDir, publicReleaseRing: 'preview' });
    await mkdir(join(homeDir, 'cache'), { recursive: true });
    // What the pre-R13 doctor repair wrote: npm `next`, unfiltered, `updateAvailable: true` unconditionally.
    await writeFile(cachePath, JSON.stringify({ checkedAt: 5, latest: '0.2.20-dev.1', updateAvailable: true }));
    expect(readCachedCliUpdateState({ homeDir, publicReleaseRing: 'preview', currentVersion: '0.2.13-preview.1' }))
      .toEqual({ currentVersion: '0.2.13-preview.1', latestVersion: null, updateAvailable: false, checkedAt: 5 });
  });
});
