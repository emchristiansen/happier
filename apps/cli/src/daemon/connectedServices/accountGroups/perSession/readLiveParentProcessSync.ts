import { readFileSync } from 'node:fs';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import type { PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';

/** The `/proc` stat fields after the command name, or null when unreadable. */
function readProcStatFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
  } catch {
    return null;
  }
}

/**
 * The live parent of `pid` with its process-instance fingerprint, or null when either is unknown. A
 * parent without a fingerprint is not returned: it could not be told apart from a reused pid. Linux
 * only, from `/proc` (the daemon never blocks on a child process here); elsewhere it is unknown and a
 * wrapper's reattached child is not adoptable through its parent.
 */
export function readLiveParentProcessSync(pid: number): PerSessionAssignmentRunner | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  const ppid = Number(readProcStatFields(pid)?.[1]);
  if (!Number.isInteger(ppid) || ppid <= 1) return null;
  const processInstanceFingerprint = readProcessInstanceFingerprintSync(ppid);
  return processInstanceFingerprint ? { pid: ppid, processInstanceFingerprint } : null;
}
