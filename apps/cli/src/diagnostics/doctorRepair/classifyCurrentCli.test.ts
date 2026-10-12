import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyCurrentCli } from './classifyCurrentCli';

describe('classifyCurrentCli reads the one update-check cache', () => {
  let homeDir = '';
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happier-doctor-cli-update-'));
    mkdirSync(join(homeDir, 'cache'), { recursive: true });
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports the ring\'s newer version from the cached check', async () => {
    writeFileSync(join(homeDir, 'cache', 'update.preview.json'), JSON.stringify({ checkedAt: Date.now(), latest: '0.2.14-preview.2' }));
    await expect(classifyCurrentCli({
      homeDir,
      currentCliReleaseChannel: 'preview',
      currentCliRingId: 'preview',
      currentCliVersion: '0.2.13-preview.1',
      forceRefresh: true,
    })).resolves.toEqual([expect.objectContaining({
      kind: 'cli_self_update_available',
      currentVersion: '0.2.13-preview.1',
      latestVersion: '0.2.14-preview.2',
    })]);
  });

  it('never announces another ring\'s version and never writes the shared cache', async () => {
    const cachePath = join(homeDir, 'cache', 'update.preview.json');
    const cached = JSON.stringify({ checkedAt: Date.now(), latest: '0.2.20-dev.1', updateAvailable: true });
    writeFileSync(cachePath, cached);
    await expect(classifyCurrentCli({
      homeDir,
      currentCliReleaseChannel: 'preview',
      currentCliRingId: 'preview',
      currentCliVersion: '0.2.13-preview.1',
      forceRefresh: true,
    })).resolves.toEqual([]);
    expect(readFileSync(cachePath, 'utf8')).toBe(cached);
  });
});
