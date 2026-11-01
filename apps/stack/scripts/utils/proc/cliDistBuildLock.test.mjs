import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { withBuildSharedDepsLock } from '../../../../cli/scripts/buildSharedDeps.mjs';

test('withCliDistBuildLock passes its current owner lease to the real buildSharedDeps lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-lock-build-shared-reentry-'));
  try {
    const lockPath = join(root, 'cli-dist-build.lock');
    const result = await withCliDistBuildLock(
      async ({ heldLockValue }) =>
        await withBuildSharedDepsLock(
          async () => 'nested',
          {
            lockPath,
            env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
          },
        ),
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(result, 'nested');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real buildSharedDeps lock owner rejects a path-only inherited marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-lock-path-only-reentry-'));
  try {
    const lockPath = join(root, 'cli-dist-build.lock');
    await withCliDistBuildLock(
      async () => {
        await assert.rejects(
          () => withBuildSharedDepsLock(
            async () => 'nested',
            {
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath },
              timeoutMs: 60,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          ),
          /Timed out waiting for workspace bundle lock/,
        );
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real buildSharedDeps lock owner rejects a foreign token for the current path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-lock-foreign-lease-'));
  try {
    const lockPath = join(root, 'cli-dist-build.lock');
    const foreignLease = JSON.stringify({ v: 1, path: lockPath, token: 'foreign-owner-token' });
    await withCliDistBuildLock(
      async () => {
        await assert.rejects(
          () => withBuildSharedDepsLock(
            async () => 'nested',
            {
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: foreignLease },
              timeoutMs: 60,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          ),
          /Timed out waiting for workspace bundle lock/,
        );
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the real buildSharedDeps lock owner rejects a stale lease after a successor owns the path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-lock-stale-lease-'));
  try {
    const lockPath = join(root, 'cli-dist-build.lock');
    const staleLease = await withCliDistBuildLock(
      async ({ heldLockValue }) => heldLockValue,
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
    );

    await withCliDistBuildLock(
      async () => {
        await assert.rejects(
          () => withBuildSharedDepsLock(
            async () => 'nested',
            {
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: staleLease },
              timeoutMs: 60,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          ),
          /Timed out waiting for workspace bundle lock/,
        );
      },
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock reclaims a fresh lock from a dead owner pid immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-'));
  const lockPath = join(root, 'cli-dist-build.lock');

  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = await withCliDistBuildLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock reports wait progress while a live owner holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-wait-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const waitEvents = [];

  try {
    const holder = withCliDistBuildLock(
      async () => {
        await delay(40);
        return 'held';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    while (true) {
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        break;
      } catch {
        await delay(1);
      }
    }

    const result = await withCliDistBuildLock(
      async ({ waited }) => {
        assert.equal(waited, true);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
        onWait: (event) => {
          waitEvents.push(event);
        },
      },
    );

    assert.equal(result, 'ok');
    assert.ok(waitEvents.length >= 1);
    assert.equal(waitEvents[0].lockPath, lockPath);
    assert.equal(waitEvents[0].owner.pid, process.pid);

    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not reclaim an old lock while the owner pid is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-live-owner-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const owner = {
    pid: process.pid,
    createdAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 60_000,
  };
  let enteredCriticalSection = false;

  try {
    await writeFile(lockPath, JSON.stringify(owner), 'utf8');

    await assert.rejects(
      () =>
        withCliDistBuildLock(
          async () => {
            enteredCriticalSection = true;
          },
          {
            lockPath,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 10,
          },
        ),
      /Timed out waiting for CLI dist build lock/,
    );

    assert.equal(enteredCriticalSection, false);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not heartbeat over or unlink a successor owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-successor-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const successorOwner = {
    pid: process.pid + 1_000_000,
    createdAtMs: Date.now() + 1,
    updatedAtMs: Date.now() + 1,
  };

  try {
    await withCliDistBuildLock(
      async () => {
        await writeFile(lockPath, JSON.stringify(successorOwner), 'utf8');
        await delay(620);
        assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 20,
      },
    );

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not delete a successor owner during stale-owner reclaim', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-reclaim-race-'));
  try {
    const moduleUrl = new URL('./cliDistBuildLock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';

const realFs = { ...fs };
const lockPath = join(${JSON.stringify(tmp)}, 'cli-dist-build.lock');
const staleOwner = {
  pid: 999999,
  createdAtMs: Date.now() - 60_000,
  updatedAtMs: Date.now() - 60_000,
};
const successorRaw = JSON.stringify({
  pid: process.pid,
  createdAtMs: Date.now() + 1,
  updatedAtMs: Date.now() + 1,
});
let replacements = 0;
let readsAfterReplacement = 0;
let enteredCriticalSection = false;
let fakeLivenessReads = 0;
let fakeFingerprintReads = 0;
let forbiddenBoundaryCalls = 0;
const openPaths = new Map();
const forbidden = () => {
  forbiddenBoundaryCalls++;
  throw new Error('real process or network boundary forbidden');
};

// The real lock owner runs with fake OS/process/network boundaries, as in its canonical tests.
process.kill = (pid, signal) => {
  assert.equal(signal, 0);
  fakeLivenessReads++;
  if (pid === process.pid) return true;
  assert.equal(pid, staleOwner.pid);
  throw Object.assign(new Error('fixture absent process'), { code: 'ESRCH' });
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = forbidden;
}
childProcess.spawnSync = (command, args) => {
  if (command === 'ps') {
    assert.deepEqual(args, ['-o', 'lstart=', '-p', String(process.pid)]);
    fakeFingerprintReads++;
    return { status: 0, stdout: 'Mon Jan 01 00:00:00 2024' };
  }
  if (command === 'powershell.exe') {
    assert.ok(args.at(-1).includes('ProcessId=' + process.pid));
    fakeFingerprintReads++;
    return { status: 0, stdout: '2024-01-01T00:00:00.000Z' };
  }
  return forbidden();
};
globalThis.fetch = forbidden;
for (const name of ['connect', 'createConnection', 'createServer']) net[name] = forbidden;
for (const transport of [http, https]) {
  for (const name of ['request', 'get', 'createServer']) transport[name] = forbidden;
}
fs.openSync = (...args) => {
  const fd = realFs.openSync(...args);
  openPaths.set(fd, String(args[0]));
  return fd;
};
fs.closeSync = (fd) => {
  openPaths.delete(fd);
  return realFs.closeSync(fd);
};
fs.readFileSync = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('/proc/') && args[0].endsWith('/stat')) {
    fakeFingerprintReads++;
    return '1 (fixture) S ' + Array(18).fill('0').join(' ') + ' 100';
  }
  const raw = realFs.readFileSync(...args);
  if ((openPaths.get(args[0]) ?? String(args[0])) === lockPath) {
    if (replacements === 0 && JSON.parse(String(raw)).pid === staleOwner.pid) {
      // Return the stale snapshot, then replace it before the real owner's identity recheck.
      replacements++;
      realFs.writeFileSync(lockPath, successorRaw, 'utf8');
    } else if (replacements === 1) {
      readsAfterReplacement++;
    }
  }
  return raw;
};
syncBuiltinESMExports();
assert.equal((await import('node:fs')).readFileSync, fs.readFileSync);
assert.equal((await import('node:child_process')).spawnSync, childProcess.spawnSync);
assert.equal((await import('node:net')).connect, forbidden);
assert.equal((await import('node:http')).request, forbidden);
assert.equal((await import('node:https')).request, forbidden);
assert.equal(globalThis.fetch, forbidden);
realFs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');
const { withCliDistBuildLock } = await import(${JSON.stringify(moduleUrl)});
await assert.rejects(
  () => withCliDistBuildLock(
    async () => { enteredCriticalSection = true; },
    { lockPath, timeoutMs: 80, pollIntervalMs: 10, staleAfterMs: 1 },
  ),
  /Timed out waiting for CLI dist build lock/,
);
assert.equal(replacements, 1, 'successor injection must reach the actual snapshot boundary');
assert.ok(readsAfterReplacement >= 1, 'the real owner must inspect the replaced snapshot');
assert.equal(enteredCriticalSection, false);
assert.equal(realFs.readFileSync(lockPath, 'utf8'), successorRaw);
assert.ok(fakeLivenessReads >= 1);
assert.ok(fakeFingerprintReads >= 1);
assert.equal(forbiddenBoundaryCalls, 0);
parentPort.postMessage({ replacements, readsAfterReplacement, forbiddenBoundaryCalls });
parentPort.close();
`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`));
    let report;
    let workerError;
    worker.once('message', (value) => { report = value; });
    worker.once('error', (error) => { workerError = error; });
    const exitCode = await new Promise((resolve) => worker.once('exit', resolve));
    assert.ifError(workerError);
    assert.equal(exitCode, 0);
    assert.equal(report?.replacements, 1);
    assert.equal(report?.forbiddenBoundaryCalls, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock removes and reacquires the lock after cleanup on Windows-shaped filesystems', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-cleanup-'));
  try {
    const moduleUrl = new URL('./cliDistBuildLock.mjs', import.meta.url).href;
    const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalUnlinkSync = fs.unlinkSync;
const openLockPaths = new Map();

fs.openSync = function patchedOpenSync(path, flags, mode) {
  const fd = originalOpenSync.call(this, path, flags, mode);
  openLockPaths.set(String(path), fd);
  return fd;
};

fs.closeSync = function patchedCloseSync(fd) {
  for (const [path, openFd] of openLockPaths.entries()) {
    if (openFd === fd) {
      openLockPaths.delete(path);
      break;
    }
  }
  return originalCloseSync.call(this, fd);
};

fs.unlinkSync = function patchedUnlinkSync(path) {
  if (openLockPaths.has(String(path))) {
    const error = new Error(\`EPERM: file is in use, unlink '\${String(path)}'\`);
    error.code = 'EPERM';
    throw error;
  }
  return originalUnlinkSync.call(this, path);
};

syncBuiltinESMExports();

const { withCliDistBuildLock } = await import(${JSON.stringify(moduleUrl)});
const lockPath = join(${JSON.stringify(tmp)}, 'locks', 'cli-dist-build.lock');

await withCliDistBuildLock(
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);

await withCliDistBuildLock(
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);
`;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
