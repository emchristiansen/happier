import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type CodexSharedControlEndpoint = Readonly<{
  version: 1;
  sessionId: string;
  endpoint: string;
  updatedAt: number;
}>;

function endpointPath(happyHomeDir: string, sessionId: string): string {
  return join(happyHomeDir, 'codex', 'shared-control', 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

function parseEndpoint(raw: string, sessionId: string): CodexSharedControlEndpoint | null {
  const value = JSON.parse(raw) as Partial<CodexSharedControlEndpoint> | null;
  if (!value || value.version !== 1 || value.sessionId !== sessionId) return null;
  if (typeof value.endpoint !== 'string' || value.endpoint.trim().length === 0) return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  return value as CodexSharedControlEndpoint;
}

async function withEndpointLock<TResult>(path: string, effect: () => Promise<TResult>): Promise<TResult> {
  return await withJsonOwnerFileLock({
    lockPath: `${path}.lock`,
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    errorCode: 'codex_shared_control_endpoint_lock_unavailable',
  }, effect);
}

export async function writeCodexSharedControlEndpoint(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  endpoint: string;
}>): Promise<void> {
  const path = endpointPath(params.happyHomeDir, params.sessionId);
  const directory = join(params.happyHomeDir, 'codex', 'shared-control', 'sessions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  await withEndpointLock(path, async () => {
    await writeJsonAtomic(path, {
      version: 1,
      sessionId: params.sessionId,
      endpoint: params.endpoint,
      updatedAt: Date.now(),
    } satisfies CodexSharedControlEndpoint);
  });
  await chmod(path, 0o600).catch(() => {});
}

export async function readCodexSharedControlEndpoint(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<CodexSharedControlEndpoint | null> {
  try {
    return parseEndpoint(await readFile(endpointPath(params.happyHomeDir, params.sessionId), 'utf8'), params.sessionId);
  } catch {
    return null;
  }
}

export async function removeCodexSharedControlEndpoint(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedEndpoint: string;
}>): Promise<boolean> {
  const path = endpointPath(params.happyHomeDir, params.sessionId);
  try {
    return await withEndpointLock(path, async () => {
      const current = parseEndpoint(await readFile(path, 'utf8'), params.sessionId);
      if (current?.endpoint !== params.expectedEndpoint) return false;
      await unlink(path);
      return true;
    });
  } catch {
    return false;
  }
}
