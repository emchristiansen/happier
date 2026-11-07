import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerifyResumeReachableInput, VerifyResumeReachableResult } from '@/backends/connectedServices/verifyResumeReachableTypes';

export async function verifyResumeReachableAgy(input: VerifyResumeReachableInput): Promise<VerifyResumeReachableResult> {
  const id = input.vendorResumeId?.trim();
  const home = input.targetMaterializedEnv.GEMINI_HOME?.trim();
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..' || !home) {
    return { ok: false, reason: 'agy_session_state_not_found' };
  }
  const root = join(home, 'antigravity-acp');
  const db = join(root, 'conversations', `${id}.db`);
  try {
    const [dbStat, brainStat, metadata] = await Promise.all([
      stat(db), stat(join(root, 'brain', id)), readFile(join(root, 'conversations', `${id}.meta`), 'utf8'),
    ]);
    const parsed: unknown = JSON.parse(metadata);
    if (!dbStat.isFile() || !brainStat.isDirectory() || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'agy_session_state_not_found' };
    }
    return { ok: true, resolvedPath: db };
  } catch {
    return { ok: false, reason: 'agy_session_state_not_found' };
  }
}
