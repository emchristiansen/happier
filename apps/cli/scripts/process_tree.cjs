async function psList() { return (await import('ps-list')).default(); }

function isPidAliveBySignal(pid, onProbeFailure) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denial or an unrecognized probe failure does not establish process death.
    const absent = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
    if (!absent) onProbeFailure?.();
    return !absent;
  }
}

async function resolveDescendantPidsOnce(rootPid, enumerate) {
  const processes = await enumerate();
  const childrenByParent = new Map();
  for (const p of processes) {
    if (typeof p.pid !== 'number' || typeof p.ppid !== 'number') continue;
    const list = childrenByParent.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenByParent.set(p.ppid, list);
  }

  const out = [];
  const seen = new Set();
  const visit = (pid) => {
    const kids = childrenByParent.get(pid) ?? [];
    for (const childPid of kids) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      visit(childPid);
      out.push(childPid);
    }
  };

  visit(rootPid);
  return out;
}

async function resolveDescendantPids(rootPid, enumerate) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolveDescendantPidsOnce(rootPid, enumerate);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function bestEffortKillPid(pid, signal, onSignalFailure) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      onSignalFailure();
    }
    return false;
  }
}

async function waitForAllGone(pids, timeoutMs, isAlive, othersRemain = () => false) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid)) && !othersRemain()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Discovery never pauses the root: suspending a process (SIGSTOP) is forbidden, and a stopped
// root would also be left frozen if this owner died mid-cleanup. The root keeps running while
// descendants are found, so its parent links stay intact: discovery repeats until a fresh
// snapshot finds nothing new, and continues while the root is shutting down.
//
// Coverage is reported, never assumed. A caller that itself spawned the root as the leader of
// its own process group (POSIX `detached: true`) may declare `processGroup: 'owned'`; root
// signals then go to that group, which also reaches a member no snapshot listed. Without that
// declaration, or when the group cannot be validated against the same root at the moment of
// use, unguarded cleanup is `snapshot` coverage: a child the root forks after the last snapshot
// can be reparented beyond this owner's knowledge. Guarded cleanup refuses that case instead, as
// `snapshot_only`, before signalling anything it has not already validated. (The former SIGSTOP fence closed only forks during
// the snapshot itself; a root could still fork from its own SIGTERM handler after resuming.)
const MAX_DISCOVERY_ROUNDS = 4;
const GRACE_REDISCOVERY_INTERVAL_MS = 100;

async function discoverNewDescendants(rootPid, enumerate, known) {
  const found = [];
  for (const pid of await resolveDescendantPids(rootPid, enumerate)) {
    if (known.has(pid)) continue;
    known.add(pid);
    found.push(pid);
  }
  return found;
}

/**
 * Whether a declared owned process group may be signalled as `-pid` now. This only vetoes a
 * declaration; it never promotes an undeclared root. Linux exposes the current group id, which
 * must still equal the root PID; other POSIX systems rely on the declaration plus the root
 * identity check made immediately before. Windows has no POSIX process groups.
 */
function declaredProcessGroupHolds(pid) {
  if (process.platform === 'win32') return false;
  if (process.platform !== 'linux') return true;
  try {
    const stat = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name: state, ppid, pgrp, ...
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[2]) === pid;
  } catch {
    return false;
  }
}

async function terminateProcessTree(proc, opts, enumerate, guard) {
  const pid = proc.pid;
  const rootHasExited = () => proc.exitCode != null || proc.signalCode != null;
  if (!pid || rootHasExited()) return { rootObservedAlive: false, rootOutcome: 'root_not_same', coverage: 'snapshot' };

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);
  let probeFailed = false;
  let signallingFailed = false;
  let rootOutcome = 'completed';
  const rootHolds = () => {
    if (rootOutcome !== 'completed') return false;
    if (!guard) return !rootHasExited();
    const identity = guard.readRootIdentity();
    if (identity === 'same' && !rootHasExited()) return true;
    rootOutcome = identity === 'not_same' || rootHasExited() ? 'root_not_same' : 'root_unreadable';
    return false;
  };
  const onSignalFailure = () => { signallingFailed = true; };
  // An observed child exit revokes authority over its numeric PID, including after a wait.
  const isAlive = (targetPid) => !(targetPid === pid && (rootHasExited() || rootOutcome !== 'completed'))
    && isPidAliveBySignal(targetPid, () => { probeFailed = true; });
  const kill = (targetPid, signal) => {
    if (targetPid !== pid || !rootHasExited()) return bestEffortKillPid(targetPid, signal, onSignalFailure);
    return false;
  };
  // The group is signalled only when the caller declared it owns the root's group, the root is
  // still that same process (the guard, or the owner's own exit record for a ChildProcess), and
  // no OS evidence contradicts that group. An unguarded owner otherwise signals only the root PID.
  // A guarded owner needs whole-tree coverage: without the group it signals nothing further.
  const groupDeclared = opts?.processGroup === 'owned';
  const rootIdentityKnown = Boolean(guard) || ('exitCode' in proc && 'signalCode' in proc);
  const groupHolds = () => groupDeclared && rootIdentityKnown && declaredProcessGroupHolds(pid);
  const groupRequired = () => {
    if (groupHolds()) return true;
    if (rootOutcome === 'completed') rootOutcome = 'snapshot_only';
    return false;
  };
  let coverage = 'snapshot';
  let rootSignalled = false;
  // One group observation decides each root signal. A guarded owner that cannot validate the group
  // at that moment sends nothing and records the refusal; a later successful observation never
  // stands in for a signal that was not sent.
  const signalRoot = (signal) => {
    if (!rootHolds()) return false;
    const viaGroup = groupHolds();
    if (guard && !viaGroup) {
      if (rootOutcome === 'completed') rootOutcome = 'snapshot_only';
      return false;
    }
    // Coverage is the weakest of every root signal actually sent.
    coverage = viaGroup && (!rootSignalled || coverage === 'process_group') ? 'process_group' : 'snapshot';
    rootSignalled = true;
    return viaGroup ? bestEffortKillPid(-pid, signal, onSignalFailure) : kill(pid, signal);
  };

  // Keep child runtimes attached to their owning CLI process tree and explicitly terminate
  // descendants on disposal so provider processes cannot outlive their supervisor.
  if (guard && (!rootHolds() || !groupRequired())) return { rootObservedAlive: false, rootOutcome, coverage };
  let rootObservedAlive = isAlive(pid);

  // After the root has gone, the owner no longer holds its group and must not signal `-pid`. A
  // group member the snapshots never listed (for example one forked by the root's SIGTERM
  // handler) can still be running, so termination is not complete while the group the owner
  // signalled still has members. Signal 0 delivers nothing; it only asks whether the group exists.
  // A false positive (an unreaped zombie, or a reused group id) yields incomplete, never completed.
  const groupMembersRemain = () => {
    if (!(rootSignalled && coverage === 'process_group') || isAlive(pid)) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
    }
  };
  const treeGone = (pids) => pids.every((target) => !isAlive(target)) && !groupMembersRemain();

  const known = new Set();
  const descendants = [];
  let discoveryFailed = false;
  try {
    for (let round = 0; round < MAX_DISCOVERY_ROUNDS; round += 1) {
      const found = await discoverNewDescendants(pid, enumerate, known);
      descendants.push(...found);
      if (round > 0 && found.length === 0) break;
      if (rootHasExited()) break;
    }
  } catch {
    // Process enumeration is an external best-effort boundary. The known root must still be
    // terminated when the OS denies or transiently exhausts that boundary; making every caller
    // fail before that attempt leaves the known root alive. Afterward, missing discovery
    // remains an unverified cleanup, not successful completion.
    discoveryFailed = true;
  }
  // Discovery yields to the OS: an externally killed root may have lost its descendants.
  // Retain discovered descendants, but never signal an exited root by its stale PID.
  if (rootHasExited()) rootObservedAlive = false;
  // A PID-only descendant snapshot is usable only if the guarded root still
  // names the same process after discovery. Discard it otherwise.
  if (guard && (!rootHolds() || !groupRequired())) return { rootObservedAlive, rootOutcome, coverage };
  const all = rootHasExited() ? [...descendants] : [...descendants, pid];

  // Try graceful first (children-first).
  for (const targetPid of descendants) kill(targetPid, 'SIGTERM');
  signalRoot('SIGTERM');

  // While the root is still shutting down it can spawn more children; they stay discoverable
  // through it until it exits, so keep looking for them during the grace period.
  const graceStart = Date.now();
  let lastDiscoveryMs = graceStart;
  while (Date.now() - graceStart < graceMs) {
    if (treeGone(all)) break;
    if (!discoveryFailed && Date.now() - lastDiscoveryMs >= GRACE_REDISCOVERY_INTERVAL_MS && isAlive(pid)) {
      lastDiscoveryMs = Date.now();
      try {
        const found = await discoverNewDescendants(pid, enumerate, known);
        // Like the first snapshot, a later one is used only while the root still names the same
        // process; this check must not turn a root's ordinary exit into an identity failure.
        if (found.length > 0 && !rootHasExited() && (!guard || guard.readRootIdentity() === 'same')) {
          for (const targetPid of found) kill(targetPid, 'SIGTERM');
          descendants.push(...found);
          all.unshift(...found);
        }
      } catch {
        discoveryFailed = true;
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0 && !groupMembersRemain() && !discoveryFailed && !probeFailed && !signallingFailed) {
    return { rootObservedAlive, rootOutcome, coverage };
  }

  for (const targetPid of remaining) {
    if (targetPid === pid) signalRoot('SIGKILL');
    else kill(targetPid, 'SIGKILL');
  }
  await waitForAllGone(remaining, Math.min(250, graceMs), isAlive, groupMembersRemain);
  const groupMembersRemained = groupMembersRemain();
  // A signalable PID alone may be a defunct child. Preserve the existing reap semantics;
  // only actual OS failures, or a signalled group that still has members after its root has
  // gone, make this best-effort cleanup explicitly incomplete.
  if (discoveryFailed || probeFailed || signallingFailed || groupMembersRemained) {
    throw Object.assign(new Error('Process-tree termination could not be verified'), {
      code: 'process_tree_termination_incomplete',
      // Keep only failure categories: native errors can contain private paths or command lines.
      discoveryFailed,
      probeFailed,
      signallingFailed,
      groupMembersRemained,
    });
  }
  return { rootObservedAlive, rootOutcome, coverage };
}

async function killProcessTree(proc, opts, enumerate = psList) {
  const { rootObservedAlive, coverage } = await terminateProcessTree(proc, opts, enumerate, null);
  return { rootObservedAlive, coverage };
}

async function killProcessTreeGuarded(proc, opts, enumerate = psList) {
  return (await terminateProcessTree(proc, opts, enumerate, { readRootIdentity: opts.readRootIdentity })).rootOutcome;
}

module.exports = { isPidAliveBySignal, killProcessTree, killProcessTreeGuarded };
