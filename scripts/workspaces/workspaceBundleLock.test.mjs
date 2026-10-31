import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


// Genuine filesystem/process boundaries are interposed before the real owner is imported.
// Held synchronous callbacks model another process at the named syscall boundary; no child runs.
const require = createRequire(import.meta.url);
const fsBoundary = require('node:fs');
const cpBoundary = require('node:child_process');
const realFs = { ...fsBoundary };
let afterCreate = null;
let afterRead = null;
let beforeLink = null;
let realBoundaryAttempts = 0;
let unreadablePath = null;
const originalKill = process.kill;
const originalFetch = globalThis.fetch;
process.kill = (pid, signal) => {
  assert.equal(signal, 0);
  if (pid === process.pid) return true;
  throw Object.assign(new Error('fixture absent process'), { code: 'ESRCH' });
};
globalThis.fetch = () => { realBoundaryAttempts++; throw new Error('network forbidden'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cpBoundary[key] = () => { realBoundaryAttempts++; throw new Error(`child boundary forbidden: ${key}`); };
}
fsBoundary.openSync = (...args) => {
  if (args[0] === unreadablePath && args[1] === 'r') throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
  const fd = realFs.openSync(...args);
  if (args[1] === 'wx') afterCreate?.(String(args[0]));
  return fd;
};
fsBoundary.linkSync = (...args) => {
  beforeLink?.(...args);
  const result = realFs.linkSync(...args);
  afterCreate?.(String(args[1]));
  return result;
};
fsBoundary.readFileSync = (...args) => {
  if (typeof args[0] === 'string' && /^\/proc\/\d+\/stat$/.test(args[0])) {
    return `1 (fixture) S ${Array(18).fill('0').join(' ')} 100`;
  }
  if (args[0] === unreadablePath) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
  const value = realFs.readFileSync(...args);
  afterRead?.(args[0], value);
  return value;
};
syncBuiltinESMExports();
const checkedFs = await import('node:fs');
assert.equal(checkedFs.openSync, fsBoundary.openSync);
assert.equal(checkedFs.linkSync, fsBoundary.linkSync);
assert.equal(checkedFs.readFileSync, fsBoundary.readFileSync);
assert.equal((await import('node:child_process')).spawnSync, cpBoundary.spawnSync);
const { withWorkspaceBundleLock, withWorkspaceBundleLockSync } = await import('./workspaceBundleLock.mjs');

test.after(() => {
  assert.equal(realBoundaryAttempts, 0);
  for (const key of ['openSync', 'linkSync', 'readFileSync']) fsBoundary[key] = realFs[key];
  process.kill = originalKill;
  globalThis.fetch = originalFetch;
  syncBuiltinESMExports();
});
test.afterEach(() => { afterCreate = null; afterRead = null; beforeLink = null; unreadablePath = null; });

test('withWorkspaceBundleLock serializes concurrent workspace bundling through a single lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];
    let releaseFirst = null;

    const first = withWorkspaceBundleLock(
      async () => {
        events.push('first:start');
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    const second = withWorkspaceBundleLock(
      async () => {
        events.push('second:start');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock lets a child continue when its parent handed off the same lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-parent-held-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];

    await withWorkspaceBundleLock(
      async ({ heldLockValue }) => {
        events.push('parent:start');
        await withWorkspaceBundleLock(
          async () => {
            events.push('child:start');
          },
          {
            lockPath,
            timeoutMs: 50,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
            heldLockValue,
          },
        );
        events.push('parent:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.deepEqual(events, ['parent:start', 'child:start', 'parent:end']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock preserves same-file lock path aliases while authenticating the owner token', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-alias-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const aliasPath = join(tempRoot, 'workspace-bundling.alias.lock');

    const result = await withWorkspaceBundleLock(
      async ({ heldLockValue }) => {
        linkSync(lockPath, aliasPath);
        const lease = JSON.parse(heldLockValue);
        return await withWorkspaceBundleLock(
          async () => 'nested',
          {
            lockPath,
            heldLockValue: JSON.stringify({ ...lease, path: aliasPath }),
            timeoutMs: 50,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
          },
        );
      },
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
    );

    assert.equal(result, 'nested');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock still blocks a foreign process without a parent handoff token', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-foreign-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');

    await assert.rejects(
      withWorkspaceBundleLock(
        async () => {
          await withWorkspaceBundleLock(
            async () => {},
            {
              lockPath,
              timeoutMs: 50,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          );
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      ),
      /Timed out waiting for workspace bundle lock/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock marks contention timeout as a retryable lock outcome', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-timeout-code-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          withWorkspaceBundleLock(
            async () => {},
            {
              lockPath,
              timeoutMs: 20,
              pollIntervalMs: 5,
              staleAfterMs: 1_000,
            },
          ),
          (error) => error?.code === 'EWORKSPACEBUNDLELOCKTIMEOUT',
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
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock still reclaims a stale dead-owner lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-dead-owner-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, createdAtMs: Date.now(), token: 'dead-owner' }),
      'utf8',
    );

    let entered = false;
    await withWorkspaceBundleLock(
      async () => {
        entered = true;
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(entered, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock reclaims a live reused pid whose process instance no longer matches', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reused-pid-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
        token: 'stale-owner',
        processInstanceFingerprint: 'linux-proc:99',
      }),
      'utf8',
    );

    let entered = false;
    await withWorkspaceBundleLock(
      async () => {
        entered = true;
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
        isRunningPidImpl: () => true,
        readProcessInstanceFingerprintImpl: () => 'linux-proc:100',
      },
    );

    assert.equal(entered, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not remove a lock file that was replaced by a successor owner', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-successor-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const successorOwner = { pid: process.pid, createdAtMs: Date.now(), token: 'successor-owner' };

    await withWorkspaceBundleLock(
      async () => {
        writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), successorOwner);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLockSync uses the shared workspace bundle lock owner format', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-sync-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let observedOwner = null;

    const result = withWorkspaceBundleLockSync(
      () => {
        observedOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
        readProcessInstanceFingerprintImpl: () => 'test-process-instance',
      },
    );

    assert.equal(result, 'ok');
    assert.equal(observedOwner.pid, process.pid);
    assert.equal(typeof observedOwner.createdAtMs, 'number');
    assert.equal(typeof observedOwner.token, 'string');
    assert.equal(typeof observedOwner.processInstanceFingerprint, 'string');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not reclaim a stale lock while the owner pid is alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-live-'));
  const lockPath = join(root, 'lock');
  const raw = JSON.stringify({ pid: process.pid, token: 'live', createdAtMs: 1, processInstanceFingerprint: 'linux-proc:100' });
  writeFileSync(lockPath, raw);
  try {
    await assert.rejects(withWorkspaceBundleLock(() => assert.fail('live callback'), {
      lockPath, timeoutMs: 20, pollIntervalMs: 1, staleAfterMs: 1,
    }), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
    assert.equal(readFileSync(lockPath, 'utf8'), raw);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withWorkspaceBundleLock heartbeat does not overwrite a successor lock file', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-heartbeat-successor-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const successorOwner = { pid: process.pid, createdAtMs: Date.now(), token: 'heartbeat-successor-owner' };

    await withWorkspaceBundleLock(
      async () => {
        writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 350));
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), successorOwner);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const mode of ['async', 'sync']) {
  for (const [label, raw] of [['empty', ''], ['malformed', '{'], ['unreadable', 'fixture-owned opaque bytes']]) {
    test(`J079 ${mode} preserves ${label} unknown owner`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'happier-lock-unknown-'));
      const lockPath = join(root, 'lock');
      writeFileSync(lockPath, raw);
      if (label === 'unreadable') unreadablePath = lockPath;
      const options = { lockPath, timeoutMs: 15, pollIntervalMs: 1, staleAfterMs: 1 };
      try {
        if (mode === 'sync') assert.throws(() => withWorkspaceBundleLockSync(() => assert.fail('unknown owner entered'), options), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
        else await assert.rejects(withWorkspaceBundleLock(() => assert.fail('unknown owner entered'), options), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
        unreadablePath = null;
        assert.equal(readFileSync(lockPath, 'utf8'), raw);
      } finally { unreadablePath = null; rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const observed of ['linux-ps:Fri Oct 30 00:00:00 2026', null, 'unsupported:new', 'linux-proc:001', 'win32-cim:broken']) {
  test(`J079 incomparable fingerprint ${String(observed)} is unknown`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-lock-format-'));
    const lockPath = join(root, 'lock');
    const raw = JSON.stringify({ pid: process.pid, token: 'old', createdAtMs: 1, processInstanceFingerprint: 'linux-proc:99' });
    writeFileSync(lockPath, raw);
    try {
      await assert.rejects(withWorkspaceBundleLock(() => assert.fail('incomparable entered'), {
        lockPath, timeoutMs: 15, pollIntervalMs: 1, isRunningPidImpl: () => true,
        readProcessInstanceFingerprintImpl: () => observed,
      }), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
      assert.equal(readFileSync(lockPath, 'utf8'), raw);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('J079 canonical publication is complete before a competing acquirer can observe it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-lock-publication-'));
  const lockPath = join(root, 'lock');
  const events = [];
  let second;
  let observedRaw;
  afterCreate = (path) => {
    if (path !== lockPath || second) return;
    afterCreate = null;
    observedRaw = realFs.readFileSync(lockPath, 'utf8');
    second = withWorkspaceBundleLock(async () => { events.push('second'); }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
  };
  try {
    await withWorkspaceBundleLock(async () => { events.push('first'); }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
    await second;
    assert.ok(observedRaw, 'canonical record must never be empty at publication');
    assert.deepEqual(events, ['first', 'second']);
  } finally { afterCreate = null; if (second) await second; rmSync(root, { recursive: true, force: true }); }
});

test('J079 concurrent reclaimers cannot remove the first successor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-lock-reclaim-'));
  const lockPath = join(root, 'lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: 'dead', createdAtMs: 1 }));
  let second;
  let secondActive = false;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const events = [];
  afterRead = (path, value) => {
    if (String(value).includes('"token":"dead"')) {
      afterRead = null;
      second = withWorkspaceBundleLock(async () => { secondActive = true; events.push('second'); await secondGate; secondActive = false; }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
    }
  };
  try {
    let overlapped = false;
    await withWorkspaceBundleLock(() => { overlapped = secondActive; events.push('first'); releaseSecond(); }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
    await second;
    assert.equal(overlapped, false, 'competing reclaimed callback must not be active');
    assert.deepEqual(events, ['first', 'second']);
  } finally { afterRead = null; releaseSecond(); if (second) await second; rmSync(root, { recursive: true, force: true }); }
});

test('J079 orphan transition guard is preserved and blocks callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-lock-guard-'));
  const lockPath = join(root, 'lock');
  const guard = `${lockPath}.transition`;
  writeFileSync(guard, 'orphan fixture bytes');
  try {
    await assert.rejects(withWorkspaceBundleLock(() => assert.fail('orphan guard entered'), { lockPath, timeoutMs: 15, pollIntervalMs: 1 }), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
    assert.equal(readFileSync(guard, 'utf8'), 'orphan fixture bytes');
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('J079 publication failure preserves callback identity and leaves no canonical owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-lock-link-failure-'));
  const lockPath = join(root, 'lock');
  const failure = new Error('fixture link failure');
  beforeLink = (source, target) => { if (target === lockPath) throw failure; };
  try {
    await assert.rejects(withWorkspaceBundleLock(() => assert.fail('failed publication entered'), { lockPath }), (error) => error === failure);
    assert.deepEqual(realFs.readdirSync(root), []);
  } finally { beforeLink = null; rmSync(root, { recursive: true, force: true }); }
});

for (const failProbe of ['permission', 'fingerprint']) {
  test(`J079 failed ${failProbe} evidence does not authorize reclaim`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-lock-probe-'));
    const lockPath = join(root, 'lock');
    const raw = JSON.stringify({ pid: process.pid, token: 'unknown', createdAtMs: 1, processInstanceFingerprint: 'linux-proc:99' });
    writeFileSync(lockPath, raw);
    try {
      await assert.rejects(withWorkspaceBundleLock(() => assert.fail('failed probe entered'), {
        lockPath, timeoutMs: 15, pollIntervalMs: 1,
        isRunningPidImpl: () => { if (failProbe === 'permission') throw Object.assign(new Error('fixture permission'), { code: 'EPERM' }); return true; },
        readProcessInstanceFingerprintImpl: (pid) => { if (failProbe === 'fingerprint') throw new Error('fixture probe failed'); return 'linux-proc:100'; },
      }), { code: 'EWORKSPACEBUNDLELOCKTIMEOUT' });
      assert.equal(readFileSync(lockPath, 'utf8'), raw);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mode of ['async', 'sync']) {
  test(`J079 ${mode} incomplete release preserves primary thrown identity`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-lock-release-'));
    const lockPath = join(root, 'lock');
    const primary = new Error('original callback');
    const warnings = [];
    const savedWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    const callback = () => { writeFileSync(`${lockPath}.transition`, 'fixture unknown guard'); throw primary; };
    try {
      if (mode === 'sync') assert.throws(() => withWorkspaceBundleLockSync(callback, { lockPath, timeoutMs: 15, pollIntervalMs: 1 }), (error) => error === primary);
      else await assert.rejects(withWorkspaceBundleLock(callback, { lockPath, timeoutMs: 15, pollIntervalMs: 1 }), (error) => error === primary);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0][0], /Failed to release/);
      assert.equal(readFileSync(`${lockPath}.transition`, 'utf8'), 'fixture unknown guard');
      assert.equal(existsSync(lockPath), true);
    } finally { console.warn = savedWarn; rmSync(root, { recursive: true, force: true }); }
  });
}
