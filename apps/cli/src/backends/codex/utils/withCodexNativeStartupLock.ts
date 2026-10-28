import { userInfo } from 'node:os';
import { join } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

/** Native Codex initialization mutates shared SQLite and system-skill state. */
export async function withCodexNativeStartupLock<TResult>(
  timeoutMs: number,
  initialize: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  // Native config can override sqlite_home independently of CODEX_HOME and its env.
  // Serialize Happier-owned native starts for the OS user instead of duplicating
  // Codex's layered configuration parser. Ordinary session activity is unlocked.
  return await withJsonOwnerFileLock({
    lockPath: join(userInfo().homedir, '.happier-codex-native-startup.lock'),
    // Native initialization retains its owning RPC budget; queued startup must
    // not impose a shorter competing timeout on another valid startup.
    timeoutMs: Number.POSITIVE_INFINITY,
    staleAfterMs: timeoutMs,
    errorCode: 'codex_native_startup_lock_timeout',
    signal,
  }, initialize);
}
