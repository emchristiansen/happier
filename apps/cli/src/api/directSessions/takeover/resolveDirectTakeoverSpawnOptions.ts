import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { Credentials } from '@/persistence';
import { getDirectSessionProviderOps } from '@/backends/catalog';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import { listSessionMarkers, type DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { directSessionMarkerMatches } from '@/api/directSessions/markers/readDirectSessionMarkerIdentity';
import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';
import { resolveSpawnConnectedServicesDefaultsForAccount } from '@/session/services/resolveSpawnConnectedServicesDefaultsForAccount';

function markerMatchesDirectSession(
  marker: DaemonSessionMarker,
  linked: LoadedLinkedDirectSession,
): boolean {
  return directSessionMarkerMatches({
    marker,
    providerId: linked.providerId,
    remoteSessionId: linked.remoteSessionId,
  });
}

async function resolveTrackedConnectedServiceRuntimeSnapshot(
  linked: LoadedLinkedDirectSession,
): Promise<ConnectedServiceRuntimeSnapshot> {
  const markers = await listSessionMarkers().catch(() => [] as DaemonSessionMarker[]);
  const matches = markers
    .filter((marker) => markerMatchesDirectSession(marker, linked))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  for (const marker of matches) {
    const snapshot = mergeConnectedServiceRuntimeSnapshots(
      readConnectedServiceRuntimeSnapshot(marker.respawn),
      readConnectedServiceRuntimeSnapshot(marker.metadata),
    );
    if (hasConnectedServiceBindings(snapshot)) return snapshot;
  }
  return {};
}

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  sessionId: string;
  credentials: Credentials;
  transcriptStorage?: 'direct' | 'persisted';
  terminal?: SpawnSessionOptions['terminal'];
}>): Promise<SpawnSessionOptions | null> {
  const providerOps = await getDirectSessionProviderOps(params.linked.providerId);
  // A resume-only source (ACP session/list) owns no provider process to take over.
  if (!providerOps.resolveTakeoverSpawnOptions) return null;
  const spawnOptions = await providerOps.resolveTakeoverSpawnOptions({
    ...params,
    transcriptStorage: params.transcriptStorage ?? 'direct',
  });
  if (!spawnOptions) return null;
  const knownSnapshot = mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(params.linked.metadata),
    mergeConnectedServiceRuntimeSnapshots(
      await resolveTrackedConnectedServiceRuntimeSnapshot(params.linked),
      readConnectedServiceRuntimeSnapshot(spawnOptions),
    ),
  );
  const accountDefaults = !hasConnectedServiceBindings(knownSnapshot) && spawnOptions.backendTarget
    ? await resolveSpawnConnectedServicesDefaultsForAccount({
      credentials: params.credentials,
      backendTarget: spawnOptions.backendTarget,
    })
    : null;
  const snapshot = hasConnectedServiceBindings(knownSnapshot)
    ? knownSnapshot
    : accountDefaults ?? {};
  return {
    ...spawnOptions,
    ...(hasConnectedServiceBindings(snapshot) ? snapshot : {}),
    ...(params.terminal ? { terminal: params.terminal } : {}),
  };
}
