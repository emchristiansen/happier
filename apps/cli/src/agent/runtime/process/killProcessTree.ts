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

/**
 * What a guard knows about the root pid right now: still the intended process instance, positively
 * not it (gone, or a different instance), or alive but impossible to identify at this moment.
 */
export type ProcessTreeRootIdentity = 'same' | 'not_same' | 'unreadable';

/**
 * Result of a guarded process-tree kill. Only `completed` means the root was signalled to the end.
 * - `root_not_same`: the root pid stopped being the intended process, so it received nothing further.
 * - `root_unreadable`: the root was alive but unidentifiable at a check made while this call did not
 *   hold it suspended (before suspending it, or after resuming it); it was sent nothing further.
 * - `root_unreadable_suspended`: this call SIGSTOPped the root and could not re-identify it, so it was
 *   deliberately left stopped rather than resumed or signalled blind.
 * Descendants are signalled only from a process snapshot validated by verifying the root both before
 * and after it was taken; validated descendants are then terminated whatever the root does later.
 * If the root fails the check after the snapshot, the snapshot is discarded and no descendant is signalled.
 */
export type GuardedProcessTreeKillOutcome = 'completed' | 'root_not_same' | 'root_unreadable' | 'root_unreadable_suspended';

/** A stopped process cannot exit by itself, so a transient identity-read failure is worth a short retry. */
const DEFAULT_UNREADABLE_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100];

type RootGuard = Readonly<{
  readRootIdentity: () => ProcessTreeRootIdentity;
  unreadableRetryDelaysMs: readonly number[];
}>;

async function readRootIdentityWithRetry(guard: RootGuard): Promise<ProcessTreeRootIdentity> {
  let identity = guard.readRootIdentity();
  for (const delayMs of guard.unreadableRetryDelaysMs) {
    if (identity !== 'unreadable') return identity;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    identity = guard.readRootIdentity();
  }
  return identity;
}

async function killProcessTreeCore(pid: number, graceMs: number, guard: RootGuard | null): Promise<GuardedProcessTreeKillOutcome> {
  // Once the guard stops holding, the root is excluded from every later signal and wait.
  let rootOutcome: GuardedProcessTreeKillOutcome = 'completed';
  let rootStopped = false;
  /** Checks the guard before a root signal; true only while the root is still the intended instance. The check is not atomic with the signal. */
  const rootHolds = async (): Promise<boolean> => {
    if (rootOutcome !== 'completed') return false;
    if (!guard) return true;
    // Retrying waits, so a root that was not suspended is checked only once: it may change meanwhile.
    const identity = rootStopped ? await readRootIdentityWithRetry(guard) : guard.readRootIdentity();
    if (identity === 'same') return true;
    rootOutcome = identity === 'not_same'
      ? 'root_not_same'
      : rootStopped ? 'root_unreadable_suspended' : 'root_unreadable';
    return false;
  };

  // Keep child runtimes attached to their owning CLI process tree and explicitly terminate
  // descendants on disposal so provider processes cannot outlive their supervisor.
  // On POSIX, stop the root before taking the process-tree snapshot. Without this fence, a
  // freshly spawned descendant can be reported to its parent before it is visible in the
  // process listing; killing the parent then reparents that descendant and loses the only
  // relationship that lets this owner find it.
  if (guard && !await rootHolds()) return rootOutcome;
  if (process.platform !== 'win32' && isAlive(pid)) {
    bestEffortKillPid(pid, 'SIGSTOP');
    rootStopped = true;
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

  // The snapshot selects descendants by parent pid alone, so it describes the intended root's tree
  // only if the root was still that instance once the snapshot existed. If the root was killed and its
  // pid reused while the snapshot was taken, the listed children belong to another process. A root that
  // fails this check, or cannot be identified, leaves the snapshot unverified: signal none of it.
  if (guard && !await rootHolds()) return rootOutcome;

  // Try graceful first (children-first). These descendants were enumerated under a root verified both
  // before and after the snapshot, so they belong to its tree and are cleaned up whether or not the
  // root later exits or stops matching.
  for (const targetPid of descendants) bestEffortKillPid(targetPid, 'SIGTERM');
  if (rootStopped && await rootHolds()) {
    bestEffortKillPid(pid, 'SIGCONT');
    rootStopped = false;
  }
  if (await rootHolds()) bestEffortKillPid(pid, 'SIGTERM');
  const rootTracked = () => rootOutcome === 'completed';
  await waitForAllGone(rootTracked() ? [...descendants, pid] : descendants, graceMs);

  const remainingDescendants = descendants.filter((p) => isAlive(p));
  const rootRemaining = rootTracked() && isAlive(pid);
  if (remainingDescendants.length === 0 && !rootRemaining) return rootOutcome;

  for (const targetPid of remainingDescendants) bestEffortKillPid(targetPid, 'SIGKILL');
  if (rootRemaining && await rootHolds()) bestEffortKillPid(pid, 'SIGKILL');
  const killed = rootTracked() && rootRemaining ? [...remainingDescendants, pid] : remainingDescendants;
  await waitForAllGone(killed, Math.min(250, graceMs));
  return rootOutcome;
}

export async function killProcessTree(
  proc: ProcessTreeRoot,
  opts?: {
    graceMs?: number;
  }
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;
  await killProcessTreeCore(pid, Math.max(1, opts?.graceMs ?? 1000), null);
}

/**
 * `killProcessTree` for a root whose pid must still name one exact process instance. The guard is
 * read immediately before every signal to the root, and once more after the descendant snapshot:
 * descendants are signalled only if the root is verified both before and after that snapshot, and
 * from then on the guard no longer gates them. An unreadable identity after this call suspended the
 * root is retried with a short bounded backoff, then the root is left stopped rather than resumed blind.
 */
export async function killProcessTreeGuarded(
  proc: ProcessTreeRoot,
  opts: {
    graceMs?: number;
    readRootIdentity: () => ProcessTreeRootIdentity;
    unreadableRetryDelaysMs?: readonly number[];
  },
): Promise<GuardedProcessTreeKillOutcome> {
  const pid = proc.pid;
  if (!pid) return 'root_not_same';
  return await killProcessTreeCore(pid, Math.max(1, opts.graceMs ?? 1000), {
    readRootIdentity: opts.readRootIdentity,
    unreadableRetryDelaysMs: opts.unreadableRetryDelaysMs ?? DEFAULT_UNREADABLE_RETRY_DELAYS_MS,
  });
}
