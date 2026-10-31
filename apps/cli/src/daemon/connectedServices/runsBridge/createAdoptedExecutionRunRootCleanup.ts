import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { CatalogAgentId } from '@/backends/types';
import type { ExecutionRunRetentionPolicy } from '@happier-dev/protocol';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';

export function createAdoptedExecutionRunRootCleanup(input: Readonly<{
  materializationBaseDir: string;
  materializedRoot: string;
  agentId: CatalogAgentId;
  materializationKey: string;
  retentionPolicy?: ExecutionRunRetentionPolicy | null;
  removeRoot: (root: string) => Promise<void>;
}>): (() => Promise<void>) | null {
  const base = resolve(input.materializationBaseDir);
  const root = resolve(input.materializedRoot);
  const child = relative(base, root);
  if (!child || child.startsWith('..') || isAbsolute(child)) return null;
  const expectedRoot = resolve(resolveConnectedServiceMaterializedRootDir({
    baseDir: base,
    agentId: input.agentId,
    materializationKey: input.materializationKey,
  }));
  if (root !== expectedRoot) return null;
  return async () => {
    // Match the execution-run isolation owner: only an explicit ephemeral policy authorizes
    // deleting private run state. Unknown legacy policy must never become disposal authority.
    if (input.retentionPolicy !== 'ephemeral') return;
    try {
      const [realBase, realRoot] = await Promise.all([realpath(base), realpath(root)]);
      if (relative(realBase, realRoot) !== relative(base, expectedRoot)) return;
    } catch {
      // Missing or unresolvable roots are already clean; never let an adopted marker make cleanup
      // follow a symlinked ancestor or guess at a filesystem target.
      return;
    }
    await input.removeRoot(root);
  };
}
