export function isPidAliveBySignal(pid: number, onProbeFailure?: () => void): boolean;

export type ProcessTreeTerminationResult = Readonly<{ rootObservedAlive: boolean }>;

export function killProcessTree(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts?: Readonly<{ graceMs?: number }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<ProcessTreeTerminationResult>;

export type ProcessTreeRootIdentity = 'same' | 'not_same' | 'unreadable';
export type GuardedProcessTreeKillOutcome = 'completed' | 'root_not_same' | 'root_unreadable' | 'root_unreadable_suspended';

export function killProcessTreeGuarded(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts: Readonly<{
    graceMs?: number;
    readRootIdentity: () => ProcessTreeRootIdentity;
    unreadableRetryDelaysMs?: readonly number[];
  }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<GuardedProcessTreeKillOutcome>;
