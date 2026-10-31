import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createWorkspaceLockLeaseValue,
  workspaceLockLeaseMatchesOwner,
} from './workspaceLockLease.mjs';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE = 'EWORKSPACEBUNDLELOCKTIMEOUT';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function resolveWorkspaceBundleLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
}

function parseLockOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readLockOwnerSnapshot(lockPath) {
  let fd = null;
  try {
    fd = openSync(lockPath, 'r');
    const stats = fstatSync(fd);
    const raw = readFileSync(fd, 'utf8');
    return { exists: true, readable: true, raw, owner: parseLockOwner(raw), dev: stats.dev, ino: stats.ino };
  } catch (error) {
    // Permission/probe failures and malformed records are not an absent owner.
    return { exists: error?.code !== 'ENOENT', readable: false, raw: null, owner: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function fingerprintKind(value) {
  if (typeof value !== 'string') return null;
  if (/^linux-proc:(?:0|[1-9]\d*)$/.test(value)) return 'linux-proc';
  if (/^win32-cim:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return 'win32-cim';
  // ps lstart carries neither timezone nor probe provenance in the retained fingerprint.
  // Even equal-format strings from the same platform cannot establish replacement here.
  return null;
}

function shouldReclaimLockSnapshot(snapshot, options = {}) {
  if (!snapshot.exists) return true;
  if (!snapshot.readable || !snapshot.owner) return false;
  if (!Number.isFinite(snapshot.owner.createdAtMs) || snapshot.owner.createdAtMs <= 0) return false;
  const ownerPid = snapshot.owner.pid;
  if (!Number.isInteger(ownerPid) || ownerPid <= 1) return false;
  try {
    const running = (options.isRunningPidImpl ?? isRunningPid)(ownerPid);
    if (running === false) return true;
    if (running !== true) return false;
    const expected = snapshot.owner.processInstanceFingerprint;
    const observed = (options.readProcessInstanceFingerprintImpl ?? readProcessInstanceFingerprintSync)(ownerPid);
    const kind = fingerprintKind(expected);
    // A fallback from proc to ps changes representation, not necessarily the process instance.
    return kind !== null && kind === fingerprintKind(observed)
      && !processInstanceFingerprintMatches(expected, observed);
  } catch {
    return false;
  }
}

export function isWorkspaceBundleLockActive(lockPath, options = {}) {
  const snapshot = readLockOwnerSnapshot(lockPath);
  return snapshot.exists && !shouldReclaimLockSnapshot(snapshot, options);
}

function sameSnapshot(a, b) {
  return a.exists && b.exists && a.readable && b.readable
    && a.dev === b.dev && a.ino === b.ino && a.raw === b.raw;
}

function removeOwnedSnapshot(lockPath, expected) {
  if (sameSnapshot(readLockOwnerSnapshot(lockPath), expected)) unlinkSync(lockPath);
}

// Publish only complete records, using the same private-file/exclusive-link pattern as the
// first-party mutation owner. No contender can observe a newly published empty record.
function tryPublishOwner(lockPath, raw) {
  const privatePath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  let created = false;
  try {
    fd = openSync(privatePath, 'wx');
    created = true;
    writeFileSync(fd, raw, 'utf8');
    const stats = fstatSync(fd);
    try {
      linkSync(privatePath, lockPath);
      return { exists: true, readable: true, raw, owner: parseLockOwner(raw), dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (created) {
      try { unlinkSync(privatePath); } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Failed to remove private workspace lock record', error);
      }
    }
  }
}

function serializeLockOwner(ownerToken, fingerprint) {
  const now = Date.now();
  return JSON.stringify({ pid: process.pid, createdAtMs: now, updatedAtMs: now, token: ownerToken, processInstanceFingerprint: fingerprint });
}

function callerHoldsWorkspaceBundleLock(lockPath, heldLockValue) {
  if (!heldLockValue) return false;
  const snapshot = readLockOwnerSnapshot(lockPath);
  return snapshot.exists && workspaceLockLeaseMatchesOwner({ lockPath, leaseValue: heldLockValue, owner: snapshot.owner });
}

// Every cooperating writer, including release, takes this short guard. An orphan guard is
// deliberately never auto-reclaimed: age or an unreadable record cannot prove abandonment.
function tryTransition(lockPath, operation) {
  const guardPath = `${lockPath}.transition`;
  const guard = tryPublishOwner(guardPath, serializeLockOwner(randomUUID(), null));
  if (!guard) return { acquired: false };
  try {
    return { acquired: true, value: operation() };
  } finally {
    removeOwnedSnapshot(guardPath, guard);
  }
}

function tryAcquire(lockPath, raw, options) {
  const transition = tryTransition(lockPath, () => {
    const before = readLockOwnerSnapshot(lockPath);
    if (before.exists) {
      if (!shouldReclaimLockSnapshot(before, options)) return null;
      // Guard exclusion prevents another cooperating owner changing this path between check
      // and removal. Identity/raw comparison also preserves an already replaced record.
      const current = readLockOwnerSnapshot(lockPath);
      if (!sameSnapshot(current, before)) return null;
      unlinkSync(lockPath);
    }
    return tryPublishOwner(lockPath, raw);
  });
  return transition.acquired ? transition.value : null;
}

function createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot }) {
  const owner = snapshot.owner;
  const detail = owner ? `pid=${String(owner.pid ?? 'unknown')} ageMs=${Math.max(0, Date.now() - Number(owner.updatedAtMs ?? owner.createdAtMs ?? Date.now()))}` : 'owner=unknown';
  const error = new Error(`Timed out waiting for ${errorLabel}: ${lockPath} (${detail}; unknown records and transition guards require separate recovery)`);
  error.code = WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE;
  return error;
}

function lockSettings(options) {
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) throw new Error('Missing workspace bundle lock path');
  return {
    lockPath,
    timeoutMs: options.timeoutMs ?? 240_000,
    pollIntervalMs: options.pollIntervalMs ?? 250,
    staleAfterMs: options.staleAfterMs ?? options.timeoutMs ?? 240_000,
    heldLockValue: String(options.heldLockValue ?? options.heldLockPath ?? '').trim(),
    errorLabel: options.errorLabel ?? 'workspace bundle lock',
  };
}

function checkWait(options, settings, startedAt) {
  const snapshot = readLockOwnerSnapshot(settings.lockPath);
  if (Date.now() - startedAt > settings.timeoutMs) throw createWorkspaceBundleLockTimeoutError({ ...settings, snapshot });
  try {
    options.onWait?.({
      lockPath: settings.lockPath, owner: snapshot.owner, staleAfterMs: settings.staleAfterMs,
      timeoutMs: settings.timeoutMs, waitedMs: Date.now() - startedAt,
    });
  } catch {}
}

function lockContext(settings, token, waited) {
  return { waited, lockPath: settings.lockPath, heldLockValue: createWorkspaceLockLeaseValue({ lockPath: settings.lockPath, ownerToken: token }), inherited: false };
}

export async function withWorkspaceBundleLock(fn, options = {}) {
  const settings = lockSettings(options);
  if (callerHoldsWorkspaceBundleLock(settings.lockPath, settings.heldLockValue)) {
    return await fn({ waited: false, lockPath: settings.lockPath, heldLockValue: settings.heldLockValue, inherited: true });
  }
  mkdirSync(dirname(settings.lockPath), { recursive: true });
  const startedAt = Date.now();
  const token = randomUUID();
  let fingerprint = null;
  try { fingerprint = (options.readProcessInstanceFingerprintImpl ?? readProcessInstanceFingerprintSync)(process.pid); } catch {}
  const raw = serializeLockOwner(token, fingerprint);
  let owned;
  let waited = false;
  while (!(owned = tryAcquire(settings.lockPath, raw, options))) {
    checkWait(options, settings, startedAt);
    waited = true;
    await sleep(settings.pollIntervalMs);
  }
  try {
    return await fn(lockContext(settings, token, waited));
  } finally {
    // Like the previous finalizer, release failure does not replace the callback's outcome.
    // Preserve the still-owned record and report incomplete cleanup instead.
    try {
      const releaseStart = Date.now();
      while (!tryTransition(settings.lockPath, () => removeOwnedSnapshot(settings.lockPath, owned)).acquired) {
        checkWait(options, settings, releaseStart);
        await sleep(settings.pollIntervalMs);
      }
    } catch (error) { console.warn('Failed to release workspace bundle lock', error); }
  }
}

export function withWorkspaceBundleLockSync(fn, options = {}) {
  const settings = lockSettings(options);
  if (callerHoldsWorkspaceBundleLock(settings.lockPath, settings.heldLockValue)) {
    return fn({ waited: false, lockPath: settings.lockPath, heldLockValue: settings.heldLockValue, inherited: true });
  }
  mkdirSync(dirname(settings.lockPath), { recursive: true });
  const startedAt = Date.now();
  const token = randomUUID();
  let fingerprint = null;
  try { fingerprint = (options.readProcessInstanceFingerprintImpl ?? readProcessInstanceFingerprintSync)(process.pid); } catch {}
  const raw = serializeLockOwner(token, fingerprint);
  let owned;
  let waited = false;
  while (!(owned = tryAcquire(settings.lockPath, raw, options))) {
    checkWait(options, settings, startedAt);
    waited = true;
    sleepSync(settings.pollIntervalMs);
  }
  try {
    return fn(lockContext(settings, token, waited));
  } finally {
    try {
      const releaseStart = Date.now();
      while (!tryTransition(settings.lockPath, () => removeOwnedSnapshot(settings.lockPath, owned)).acquired) {
        checkWait(options, settings, releaseStart);
        sleepSync(settings.pollIntervalMs);
      }
    } catch (error) { console.warn('Failed to release workspace bundle lock', error); }
  }
}
