import psList from 'ps-list';

import {
  killProcessTree as terminateProcessTree,
  killProcessTreeGuarded as terminateProcessTreeGuarded,
  type ProcessTreeTerminationOptions,
  type ProcessTreeTerminationResult,
} from '../../../../scripts/process_tree.cjs';
import { logger } from '@/ui/logger';

type ProcessTreeRoot = Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>;

/**
 * What a guard knows about the root pid right now: still the intended process instance, positively
 * not it (gone, or a different instance), or alive but impossible to identify at this moment.
 */
export type ProcessTreeRootIdentity = 'same' | 'not_same' | 'unreadable';

/**
 * Result of a guarded process-tree kill. Only `completed` means the whole tree was signalled to the
 * end: every root signal reached the root's own process group, which the caller declared it owns.
 * - `snapshot_only`: no owned process group could be validated for the root, so it was sent nothing
 *   further. A guarded kill never settles for PID and snapshot signals, which a child forked after
 *   the last snapshot would survive.
 * - `root_not_same`: the root pid stopped being the intended process, so it received nothing further.
 * - `root_unreadable`: the root was alive but unidentifiable at a check; it was sent nothing further.
 * A root that exits while members of its signalled group are still running is not `completed`: the
 * owner no longer holds that group, signals it no further and throws `process_tree_termination_incomplete`
 * with `groupMembersRemained`, as it does for discovery, probe and signal failures.
 * The root is never suspended. Descendants are signalled only from a process snapshot validated by
 * verifying the root and its owned group both before and after it was taken; validated descendants
 * are then terminated whatever the root does later. If the root fails the check after the snapshot,
 * the snapshot is discarded and no descendant is signalled.
 */
export type GuardedProcessTreeKillOutcome = 'completed' | 'snapshot_only' | 'root_not_same' | 'root_unreadable';

// The launcher and compiled CLI share this CJS termination owner. Identity
// guarding is an input to that owner, not a second process-tree implementation.
async function withCleanupDiagnostic<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'process_tree_termination_incomplete') {
      logger.infoFile('[process-tree] Owned process cleanup could not be verified', {
        code: 'process_tree_termination_incomplete',
        discoveryFailed: 'discoveryFailed' in error && error.discoveryFailed === true,
        probeFailed: 'probeFailed' in error && error.probeFailed === true,
        signallingFailed: 'signallingFailed' in error && error.signallingFailed === true,
        groupMembersRemained: 'groupMembersRemained' in error && error.groupMembersRemained === true,
      });
    }
    throw error;
  }
}

/**
 * Whether a resolved unguarded termination proves the root's whole tree has stopped. Only
 * `process_group` coverage does: the root's own group was signalled to the end, and members that
 * outlive the root make the call throw instead of resolving. `snapshot` coverage signals only the
 * root and the descendants a snapshot found, so a child the snapshot missed may still run.
 */
export function processTreeTerminationProvesTreeStopped(result: ProcessTreeTerminationResult): boolean {
  return result.rootObservedAlive && result.coverage === 'process_group';
}

export async function killProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeTerminationOptions): Promise<ProcessTreeTerminationResult> {
  return await withCleanupDiagnostic(() => terminateProcessTree(proc, opts, psList));
}

/**
 * Guard the exact root before each root signal and after descendant discovery.
 * Validated descendants keep their existing termination owner even when the root
 * later exits or changes identity.
 */
export async function killProcessTreeGuarded(
  proc: ProcessTreeRoot,
  opts: ProcessTreeTerminationOptions & Readonly<{ readRootIdentity: () => ProcessTreeRootIdentity }>,
): Promise<GuardedProcessTreeKillOutcome> {
  return await withCleanupDiagnostic(() => terminateProcessTreeGuarded(proc, opts, psList));
}
