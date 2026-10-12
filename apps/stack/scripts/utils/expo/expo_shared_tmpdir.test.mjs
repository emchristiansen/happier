import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureExpoIsolationEnv, resolveExpoTmpDir } from './expo.mjs';
import { withExpoPreparationEnv } from './command.mjs';

function sha1_12(s) {
  return createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
}

test('resolveExpoTmpDir returns default when shared tmpdir is not configured', () => {
  const def = '/tmp/default';
  const got = resolveExpoTmpDir({
    env: {},
    defaultTmpDir: def,
    kind: 'expo-dev',
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, def);
});

test('resolveExpoTmpDir uses shared base dir + key when configured', () => {
  const base = '/cache/expo';
  const key = 'happier-dev/happier';
  const kind = 'expo-dev';
  const expected = join(base, 'tmp', kind, sha1_12(key));
  const got = resolveExpoTmpDir({
    env: {
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR: base,
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY: key,
    },
    defaultTmpDir: '/tmp/default',
    kind,
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, expected);
});

test('ensureExpoIsolationEnv removes stale tsx sockets without touching live ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-expo-isolation-'));
  try {
    const stateDir = join(root, 'state');
    const expoHomeDir = join(stateDir, 'expo-home');
    const isolatedTmpDir = join(stateDir, 'tmp');
    const tsxOwner = typeof process.geteuid === 'function' ? process.geteuid() : process.env.USER;
    const tsxDir = join(isolatedTmpDir, `tsx-${tsxOwner}`);
    const staleSocket = join(tsxDir, '41001.pipe');
    const liveSocket = join(tsxDir, '41002.pipe');
    await mkdir(tsxDir, { recursive: true });
    await writeFile(staleSocket, 'stale');
    await writeFile(liveSocket, 'live');

    const env = {};
    await ensureExpoIsolationEnv({
      env,
      stateDir,
      expoHomeDir,
      tmpDir: isolatedTmpDir,
      isPidAliveImpl: (pid) => pid === 41002,
    });

    await assert.rejects(access(staleSocket));
    await access(liveSocket);
    assert.equal(env.TMPDIR, isolatedTmpDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withExpoPreparationEnv isolates one-shot tools from the persistent Metro tmpdir', async () => {
  const persistentTmpDir = await mkdtemp(join(tmpdir(), 'hstack-expo-persistent-'));
  try {
    const sourceEnv = { TMPDIR: persistentTmpDir, TMP: persistentTmpDir, TEMP: persistentTmpDir };
    let observed;
    const returnedPath = await withExpoPreparationEnv(sourceEnv, async (env) => {
      observed = { tmpdir: env.TMPDIR, tmp: env.TMP, temp: env.TEMP };
      assert.notEqual(env.TMPDIR, persistentTmpDir);
      assert.equal((await stat(env.TMPDIR)).isDirectory(), true);
      return env.TMPDIR;
    });

    assert.equal(observed.tmp, observed.tmpdir);
    assert.equal(observed.temp, observed.tmpdir);
    assert.equal(sourceEnv.TMPDIR, persistentTmpDir);
    await assert.rejects(() => stat(returnedPath), { code: 'ENOENT' });
  } finally {
    await rm(persistentTmpDir, { recursive: true, force: true });
  }
});
