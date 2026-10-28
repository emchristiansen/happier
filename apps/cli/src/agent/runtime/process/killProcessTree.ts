import psList from 'ps-list';

import {
  killProcessTree as terminateProcessTree,
  killProcessTreeGuarded as terminateProcessTreeGuarded,
  type ProcessTreeTerminationResult,
} from '../../../../scripts/process_tree.cjs';
import { logger } from '@/ui/logger';

type ProcessTreeRoot = Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>;
type ProcessTreeOptions = Readonly<{ graceMs?: number }>;

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
      });
    }
    throw error;
  }
}

export async function killProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeOptions): Promise<ProcessTreeTerminationResult> {
  return await withCleanupDiagnostic(() => terminateProcessTree(proc, opts, psList));
}

/**
 * Guard the exact root before each root signal and after descendant discovery.
 * An unreadable suspended root is left stopped; validated descendants keep their
 * existing termination owner even when the root later exits or changes identity.
 */
export async function killProcessTreeGuarded(
  proc: ProcessTreeRoot,
  opts: Readonly<{
    graceMs?: number;
    readRootIdentity: () => ProcessTreeRootIdentity;
    unreadableRetryDelaysMs?: readonly number[];
  }>,
): Promise<GuardedProcessTreeKillOutcome> {
  return await withCleanupDiagnostic(() => terminateProcessTreeGuarded(proc, opts, psList));
}
