import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { resolveCatalogAgentId } from '@/backends/catalog';
import { BackendTargetRefSchema, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { TrackedSession } from '../types';

export function readBuiltInCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (target?.kind !== 'builtInAgent') return null;
  return (CATALOG_AGENT_IDS as readonly string[]).includes(target.agentId)
    ? resolveCatalogAgentId(target.agentId as CatalogAgentId)
    : null;
}

export function resolveTrackedSessionCatalogAgentId(tracked: TrackedSession): CatalogAgentId {
  if (tracked.spawnOptions?.backendTarget?.kind === 'configuredAcpBackend') return 'customAcp';
  const fromBackendTarget = readBuiltInCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
  if (fromBackendTarget) return fromBackendTarget;
  return resolveCatalogAgentId(resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook));
}

/**
 * The backend a tracked runner actually runs, for relaunching it: its explicit valid spawn target,
 * else the built-in Agent its own session metadata establishes. Null when neither establishes it;
 * unlike resolveTrackedSessionCatalogAgentId this never falls back to the catalog default, because a
 * relaunch under a guessed backend would not continue the same native session.
 */
export function resolveTrackedSessionBackendTarget(
  tracked: Pick<TrackedSession, 'spawnOptions' | 'happySessionMetadataFromLocalWebhook'>,
): BackendTargetRefV1 | null {
  const explicit = BackendTargetRefSchema.safeParse(tracked.spawnOptions?.backendTarget);
  if (explicit.success) return explicit.data;
  const metadataAgentId = resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook);
  const catalogAgentId = metadataAgentId
    ? readBuiltInCatalogAgentIdFromBackendTarget({ kind: 'builtInAgent', agentId: metadataAgentId })
    : null;
  return catalogAgentId ? { kind: 'builtInAgent', agentId: catalogAgentId } : null;
}
