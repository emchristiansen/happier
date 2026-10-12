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
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      onSignalFailure();
    }
  }
}

async function waitForAllGone(pids, timeoutMs, isAlive) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function killProcessTree(proc, opts, enumerate = psList) {
  const pid = proc.pid;
  if (!pid) return;

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);
  let signallingFailed = false;
  const onSignalFailure = () => { signallingFailed = true; };
  const isAlive = (targetPid) => isPidAliveBySignal(targetPid, onSignalFailure);
  const kill = (targetPid, signal) => bestEffortKillPid(targetPid, signal, onSignalFailure);

  // Keep child runtimes attached to their owning CLI process tree and explicitly terminate
  // descendants on disposal so provider processes cannot outlive their supervisor.
  // On POSIX, stop the root before taking the process-tree snapshot. Without this fence, a
  // freshly spawned descendant can be reported to its parent before it is visible in the
  // process listing; killing the parent then reparents that descendant and loses the only
  // relationship that lets this owner find it.
  const rootStopped = process.platform !== 'win32' && isAlive(pid);
  if (rootStopped) kill(pid, 'SIGSTOP');

  let descendants;
  let discoveryFailed = false;
  try {
    descendants = await resolveDescendantPids(pid, enumerate);
  } catch {
    // Process enumeration is an external best-effort boundary. The known root must still be
    // resumed and terminated when the OS denies or transiently exhausts that boundary; making
    // every caller fail before that attempt leaves the known root alive. Afterward,
    // missing discovery remains an unverified cleanup, not successful completion.
    discoveryFailed = true;
    descendants = [];
  }
  const all = [...descendants, pid];

  // Try graceful first (children-first).
  for (const targetPid of descendants) kill(targetPid, 'SIGTERM');
  if (rootStopped) kill(pid, 'SIGCONT');
  kill(pid, 'SIGTERM');
  await waitForAllGone(all, graceMs, isAlive);

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0 && !discoveryFailed && !signallingFailed) return;

  for (const targetPid of remaining) kill(targetPid, 'SIGKILL');
  await waitForAllGone(remaining, Math.min(250, graceMs), isAlive);
  // A signalable PID alone may be a defunct child. Preserve the existing reap semantics;
  // only actual OS failures make this best-effort cleanup explicitly incomplete.
  if (discoveryFailed || signallingFailed) {
    throw Object.assign(new Error('Process-tree termination could not be verified'), {
      code: 'process_tree_termination_incomplete',
    });
  }
}

module.exports = { isPidAliveBySignal, killProcessTree };
