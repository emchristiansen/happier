import { stat } from 'node:fs/promises';

import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';

// Bounded so a long-held writer lock delays a reader only briefly; a timeout is unproven.
// The bound covers the whole snapshot, including any in-process queue ahead of the file lock's own
// acquire timeout (which only starts once this process's earlier waiters have finished).
const GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS = 2_000;

/**
 * Read a shared Claude group home as one coherent snapshot. Every maintained writer replaces the
 * home's credentials, `.claude.json` identity and provenance record under the home's destination
 * lock (withdrawing the provenance record before it touches credentials), so anything read here
 * belongs to one completed publication or to none. A missing home, an unavailable lock, a timeout
 * or a failed read yields `unproven`; a home is never created (nor its lock) merely to read it.
 */
export async function readClaudeGroupHomeSnapshot<T>(
  claudeConfigDir: string,
  read: () => Promise<T>,
  unproven: T,
): Promise<T> {
  if (!await stat(claudeConfigDir).then((entry) => entry.isDirectory(), () => false)) return unproven;
  let abandoned = false;
  const snapshot = withConnectedServiceStateSharingDestinationLock(claudeConfigDir, async () => {
    // Past the deadline the caller has already recorded unproven; do not read for nobody.
    if (abandoned) return unproven;
    return await read();
  }, { providerId: 'claude', acquireTimeoutMs: GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS });
  // A late outcome after the deadline is ignored, including a late failure.
  snapshot.catch(() => {});
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      snapshot.catch(() => unproven),
      new Promise<T>((resolve) => {
        deadline = setTimeout(() => {
          abandoned = true;
          resolve(unproven);
        }, GROUP_HOME_SNAPSHOT_LOCK_TIMEOUT_MS);
        deadline.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
