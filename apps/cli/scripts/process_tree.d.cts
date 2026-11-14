export function isPidAliveBySignal(pid: number, onProbeFailure?: () => void): boolean;

/**
 * How far a termination reached. `process_group`: every root signal went to the root's own process
 * group, which the caller declared it owns. `snapshot`: only the root PID and descendants found by
 * process snapshots were signalled; a child forked after the last snapshot may survive.
 * Coverage is not proof of cleanup: if the root exits while members of its signalled group still
 * run, the call throws `process_tree_termination_incomplete` with `groupMembersRemained`.
 */
export type ProcessTreeTerminationCoverage = 'process_group' | 'snapshot';

export type ProcessTreeTerminationResult = Readonly<{
  rootObservedAlive: boolean;
  coverage: ProcessTreeTerminationCoverage;
}>;

/**
 * `processGroup: 'owned'` may be declared only by the owner that spawned this root itself with
 * POSIX `detached: true`, making the root the leader of its own process group.
 */
export type ProcessTreeTerminationOptions = Readonly<{ graceMs?: number; processGroup?: 'owned' }>;

export function killProcessTree(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts?: ProcessTreeTerminationOptions,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<ProcessTreeTerminationResult>;

export type ProcessTreeRootIdentity = 'same' | 'not_same' | 'unreadable';
/** `snapshot_only`: no owned process group could be validated, so the root was sent nothing further. */
export type GuardedProcessTreeKillOutcome = 'completed' | 'snapshot_only' | 'root_not_same' | 'root_unreadable';

export function killProcessTreeGuarded(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts: ProcessTreeTerminationOptions & Readonly<{ readRootIdentity: () => ProcessTreeRootIdentity }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<GuardedProcessTreeKillOutcome>;
