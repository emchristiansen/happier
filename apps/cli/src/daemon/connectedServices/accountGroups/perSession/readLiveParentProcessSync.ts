import { readFileSync } from 'node:fs';

import { readLinuxProcProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import type { PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';

/** The `/proc` stat fields after the command name, or null when unreadable. */
function readProcStatFields(pid: number, readFileSyncImpl: typeof readFileSync): string[] | null {
  try {
    const stat = String(readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'));
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
export function readLiveParentProcessSync(
  pid: number,
  options: Readonly<{ platform?: NodeJS.Platform; readFileSyncImpl?: typeof readFileSync }> = {},
): PerSessionAssignmentRunner | null {
  const readFileSyncImpl = options.readFileSyncImpl ?? readFileSync;
  if ((options.platform ?? process.platform) !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  const ppid = Number(readProcStatFields(pid, readFileSyncImpl)?.[1]);
  if (!Number.isInteger(ppid) || ppid <= 1) return null;
  // `/proc` only: a parent that disappears between the two reads is unknown, never a `ps` probe
  // (R18-PARENT-SYNC-01).
  const processInstanceFingerprint = readLinuxProcProcessInstanceFingerprintSync(ppid, { readFileSyncImpl });
  return processInstanceFingerprint ? { pid: ppid, processInstanceFingerprint } : null;
}
