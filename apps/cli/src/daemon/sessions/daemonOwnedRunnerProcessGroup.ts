import type { ChildProcess } from 'node:child_process';

import type { TrackedSession } from '../types';

/**
 * The daemon's own live spawn of a session runner, which leads the runner's process group: the
 * daemon launches runners with POSIX `detached: true` and keeps that ChildProcess on the tracked
 * session. Only this handle proves the group is the runner's, so only it lets a replacement reach
 * the runner's whole tree. A runner the daemon reattached from a marker, found in a terminal host,
 * learned of from a webhook, or promoted from an exited wrapper has none, and neither does a
 * runner whose spawned process has exited.
 */
export function readDaemonOwnedRunnerProcessGroupLeader(
  tracked: Pick<TrackedSession, 'startedBy' | 'pid' | 'childProcess'>,
): ChildProcess | null {
  const child = tracked.childProcess;
  if (tracked.startedBy !== 'daemon' || !child || child.pid !== tracked.pid) return null;
  if (child.exitCode !== null || child.signalCode !== null) return null;
  return child;
}

/**
 * Waits for the process group a daemon runner spawn led to empty. A root's exit alone proves nothing
 * about the rest of its group: a member that outlived the root keeps running under the same group id.
 * Probing uses signal 0, which delivers nothing, so no stale group is ever signalled after its
 * root has gone. Only ESRCH proves the group empty; members, permission denial or any other answer
 * is not proof, and the wait then ends unproven.
 */
export async function waitForOwnedRunnerProcessGroupEmpty(
  leaderPid: number,
  opts: Readonly<{ timeoutMs: number; pollIntervalMs: number }>,
): Promise<boolean> {
  const deadlineMs = Date.now() + Math.max(0, opts.timeoutMs);
  for (;;) {
    if (isOwnedRunnerProcessGroupProvenEmpty(leaderPid)) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, opts.pollIntervalMs)));
  }
}

/** One nondelivering observation: only ESRCH proves that no process remains in the group. */
export function isOwnedRunnerProcessGroupProvenEmpty(leaderPid: number): boolean {
  try {
    process.kill(-leaderPid, 0);
    return false;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
  }
}

/**
 * The process group a tracked daemon spawn led, for as long as its tracking record exists, whether or
 * not its root is still running. A root's exit does not retire its record at once: the exit lifecycle
 * first settles startup and marker work, stages the exit durably and cleans up resources, and a failed
 * staging leaves the record in place. Presence already reads the dead root as absent throughout.
 */
export function readTrackedOwnedRunnerProcessGroupLeaderPid(
  tracked: Pick<TrackedSession, 'startedBy' | 'pid' | 'childProcess'>,
): number | null {
  if (process.platform === 'win32') return null;
  if (tracked.startedBy !== 'daemon' || !tracked.childProcess || tracked.childProcess.pid !== tracked.pid) return null;
  return tracked.pid;
}

/** Members of a session runner's owned process group that outlived the runner's root. */
export type UnresolvedOwnedRunnerGroupTail = Readonly<{ sessionId: string; groupLeaderPid: number; retainedAtMs: number }>;

/** A session's owned runner group not yet proven empty, whether its record is still tracked or retired. */
export type UnresolvedOwnedRunnerGroup = Readonly<{
  sessionId: string;
  groupLeaderPid: number;
  holder: 'tracked_runner' | 'retained_tail';
}>;

/**
 * Remembers a daemon-owned runner group whose root exited while other members remained, after the
 * root's tracking is retired. The daemon can no longer signal that group (its custody ended with the
 * root), but until the group is proven empty a new runner for the session would run beside it. The
 * exit lifecycle retains the tail; the Resume presence probe reconciles it, discharging it only on
 * ESRCH and otherwise refusing to treat the session's runner as absent.
 */
export class OwnedRunnerGroupTailCustody {
  readonly #tailsBySessionId = new Map<string, UnresolvedOwnedRunnerGroupTail>();

  /** Retains the tail unless the group is already proven empty. Returns whether one was retained. */
  retainUnlessGroupEmpty(tail: Readonly<{ sessionId: string; groupLeaderPid: number }>): boolean {
    const sessionId = tail.sessionId.trim();
    if (!sessionId || isOwnedRunnerProcessGroupProvenEmpty(tail.groupLeaderPid)) return false;
    this.#tailsBySessionId.set(sessionId, { sessionId, groupLeaderPid: tail.groupLeaderPid, retainedAtMs: Date.now() });
    return true;
  }

  /**
   * The session's still-unresolved tail, after waiting up to `timeoutMs` for its group to empty (its
   * members normally finish their own shutdown shortly after the root). A proven-empty group is
   * discharged and yields null.
   */
  async reconcile(
    sessionIdRaw: string,
    opts: Readonly<{ timeoutMs: number; pollIntervalMs: number }>,
  ): Promise<UnresolvedOwnedRunnerGroupTail | null> {
    const sessionId = sessionIdRaw.trim();
    const tail = this.#tailsBySessionId.get(sessionId);
    if (!tail) return null;
    if (!await waitForOwnedRunnerProcessGroupEmpty(tail.groupLeaderPid, opts)) return tail;
    if (this.#tailsBySessionId.get(sessionId) === tail) this.#tailsBySessionId.delete(sessionId);
    return null;
  }

  /**
   * The session's owned runner group that is not proven empty, after waiting up to `timeoutMs`: first
   * the group of any daemon spawn still tracked for the session (`trackedGroupLeaderPids`, its root
   * possibly already dead and its exit lifecycle still running or failed), then a retained tail. The
   * tracked record and the tail cover one obligation without a gap: the exit lifecycle retains the
   * tail synchronously right before it deletes the record.
   */
  async reconcileSession(
    sessionIdRaw: string,
    trackedGroupLeaderPids: readonly number[],
    opts: Readonly<{ timeoutMs: number; pollIntervalMs: number }>,
  ): Promise<UnresolvedOwnedRunnerGroup | null> {
    const sessionId = sessionIdRaw.trim();
    const deadlineMs = Date.now() + Math.max(0, opts.timeoutMs);
    for (const groupLeaderPid of trackedGroupLeaderPids) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      if (!await waitForOwnedRunnerProcessGroupEmpty(groupLeaderPid, { ...opts, timeoutMs: remainingMs })) {
        return { sessionId, groupLeaderPid, holder: 'tracked_runner' };
      }
    }
    const tail = await this.reconcile(sessionId, { ...opts, timeoutMs: Math.max(0, deadlineMs - Date.now()) });
    return tail ? { sessionId, groupLeaderPid: tail.groupLeaderPid, holder: 'retained_tail' } : null;
  }
}
