import psList from 'ps-list';

type ProcessTreeRoot = Readonly<{ pid?: number }>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveDescendantPidsOnce(rootPid: number): Promise<number[]> {
  const processes = await psList();
  const childrenByParent = new Map<number, number[]>();
  for (const p of processes) {
    if (typeof p.pid !== 'number' || typeof p.ppid !== 'number') continue;
    const list = childrenByParent.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenByParent.set(p.ppid, list);
  }

  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number) => {
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

async function resolveDescendantPids(rootPid: number): Promise<number[]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolveDescendantPidsOnce(rootPid);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function bestEffortKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

async function waitForAllGone(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function killProcessTree(
  proc: ProcessTreeRoot,
  opts?: {
    graceMs?: number;
    /**
     * Synchronous proof that `proc.pid` is still the intended process instance. When supplied, it is
     * evaluated immediately before every signal to the root; once it fails, nothing further is sent
     * to the root or its descendants, because the pid may now name an unrelated process.
     */
    isRootIncarnation?: () => boolean;
  }
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);
  const guard = opts?.isRootIncarnation;
  const rootHolds = (): boolean => guard === undefined || guard();
  if (!rootHolds()) return;

  // Keep child runtimes attached to their owning CLI process tree and explicitly terminate
  // descendants on disposal so provider processes cannot outlive their supervisor.
  // On POSIX, stop the root before taking the process-tree snapshot. Without this fence, a
  // freshly spawned descendant can be reported to its parent before it is visible in the
  // process listing; killing the parent then reparents that descendant and loses the only
  // relationship that lets this owner find it.
  const rootStopped = process.platform !== 'win32' && isAlive(pid);
  if (rootStopped) {
    if (!rootHolds()) return;
    bestEffortKillPid(pid, 'SIGSTOP');
  }

  let descendants: number[];
  try {
    descendants = await resolveDescendantPids(pid);
  } catch {
    // Process enumeration is an external best-effort boundary. The known root must still be
    // resumed and terminated when the OS denies or transiently exhausts that boundary; making
    // every caller fail here leaves the owned process alive and amplifies cleanup failures.
    descendants = [];
  }
  const all = [...descendants, pid];

  // Try graceful first (children-first).
  if (!rootHolds()) return;
  for (const targetPid of descendants) bestEffortKillPid(targetPid, 'SIGTERM');
  if (rootStopped) {
    if (!rootHolds()) return;
    bestEffortKillPid(pid, 'SIGCONT');
  }
  if (!rootHolds()) return;
  bestEffortKillPid(pid, 'SIGTERM');
  await waitForAllGone(all, graceMs);

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0) return;

  if (!rootHolds()) return;
  for (const targetPid of remaining) {
    if (targetPid !== pid) bestEffortKillPid(targetPid, 'SIGKILL');
  }
  if (remaining.includes(pid)) {
    if (!rootHolds()) return;
    bestEffortKillPid(pid, 'SIGKILL');
  }
  await waitForAllGone(remaining, Math.min(250, graceMs));
}
