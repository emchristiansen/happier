import { resolve } from 'node:path';

import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import type { Credentials } from '@/persistence';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { readConnectedServiceMaterializationIdentityV1 } from '../createConnectedServiceMaterializationIdentity';
import { ExecutionRunConnectedServicesLaunchV1Schema } from '../../runsBridge/contract';
import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import { listMaterializedHomeTargets } from './connectedServiceMaterializedHomeTargets';
import { resolveConnectedServiceMaterializedRootDir } from '../resolveConnectedServiceMaterializedRootDir';

export async function listRetainedConnectedServiceMaterializationIdentityIds(params: Readonly<{
  credentials: Credentials;
  baseDir: string;
}>): Promise<ReadonlySet<string>> {
  const retained = new Set<string>();
  const disposableRunRoots = new Set<string>();
  // Run UUIDs are allocated independently of manager runIds. Keep the published launch identity,
  // including terminal resumable Runs, rather than guessing a key from the visible Run id.
  for (const marker of await listExecutionRunMarkers()) {
    const launch = ExecutionRunConnectedServicesLaunchV1Schema.safeParse(marker.executionRunConnectedServicesLaunchV1);
    if (!launch.success) continue;
    const identityId = normalizeMaterializationKeyForPath(launch.data.runKey);
    if (marker.retentionPolicy !== 'ephemeral') {
      retained.add(identityId);
    } else if (launch.data.materializedRoot && resolve(launch.data.materializedRoot) === resolve(
      resolveConnectedServiceMaterializedRootDir({
        baseDir: params.baseDir, agentId: launch.data.agentId, materializationKey: launch.data.runKey,
      }),
    )) {
      disposableRunRoots.add(resolve(launch.data.materializedRoot));
    }
  }
  // The predecessor terminal writer omitted the random launch key. Preserve unidentified legacy
  // hash roots from the existing cleanup inventory; only an actual ephemeral launch authorizes
  // their removal. This is retention, not evidence that a legacy Run can be adopted or resumed.
  for (const target of await listMaterializedHomeTargets(params.baseDir)) {
    if (/^[a-f0-9]{64}$/.test(target.materializationIdentityId)
      && !disposableRunRoots.has(resolve(target.path))) {
      retained.add(target.materializationIdentityId);
    }
  }
  // Archiving hides a Session from the ordinary list; it does not surrender its private history.
  // A partial listing is not deletion authority. Propagate incompleteness to the cleanup loop's
  // existing error boundary before it can remove either immediate or pending roots.
  for (const archivedOnly of [false, true]) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 50; page += 1) {
      const result = await fetchSessionsPage({
        token: params.credentials.token,
        ...(cursor ? { cursor } : {}),
        ...(archivedOnly ? { archivedOnly: true } : {}),
        limit: 200,
      });
      for (const rawSession of result.sessions) {
        const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
        if (!metadata) throw new Error('Connected-service home retention unavailable: Session metadata could not be decoded');
        const identity = readConnectedServiceMaterializationIdentityV1(metadata.connectedServiceMaterializationIdentityV1);
        if (identity) retained.add(identity.id);
      }
      if (!result.hasNext) break;
      if (!result.nextCursor || seenCursors.has(result.nextCursor) || page === 49) {
        throw new Error('Connected-service home retention unavailable: Session listing is incomplete');
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  }
  return retained;
}
