import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';

/** Compare canonical physical roots; callers own realpath resolution and admission policy. */
export function isConnectedServiceStateRootWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A resume hint may select existing managed state, never an arbitrary native/user directory. */
export async function resolveConnectedServicePreviousStateRoot(params: Readonly<{
  previousRoot: string | null | undefined;
  managedRoots: readonly string[];
}>): Promise<string | null> {
  if (!params.previousRoot?.trim()) return null;
  let previousRoot: string;
  try {
    previousRoot = await realpath(expandHomeDirPath(params.previousRoot.trim()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const root of params.managedRoots) {
    try {
      if (isConnectedServiceStateRootWithin(await realpath(root), previousRoot)) return previousRoot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  logger.infoFile('[ConnectedServices] Ignoring a previous-state hint outside managed connected-service storage');
  return null;
}
