import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';

import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

type ResolveExistingSessionAttachContext = typeof resolveExistingSessionAttachContext;

export type ResolveRespawnSessionRuntimeSnapshotParams = Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
  credentials: Credentials | null;
  readCredentials: () => Promise<Credentials | null>;
  resolveAttachContext?: ResolveExistingSessionAttachContext;
  /** Set only by the daemon-owned guarded quota transition, never an external options dump. */
  preserveTrackedOptionsForQuotaRecovery?: Readonly<{ nativeId: string }>;
}>;

export async function resolveRespawnSessionRuntimeSnapshot(
  params: ResolveRespawnSessionRuntimeSnapshotParams,
): Promise<SpawnSessionOptions> {
  const quotaPreservation = params.preserveTrackedOptionsForQuotaRecovery;
  if (quotaPreservation) {
    if (
      !quotaPreservation.nativeId
      || params.vendorResumeId !== quotaPreservation.nativeId
      || params.defaultOptions.resume !== quotaPreservation.nativeId
      || params.defaultOptions.existingSessionId !== params.sessionId
    ) {
      throw new Error('quota_recovery_respawn_identity_changed');
    }
    // An account-only transition already holds the live tracked options. Re-resolving a
    // metadata snapshot here could change model/permission or discard still-owned input.
    // Ordinary crash/manual respawns retain their durable snapshot behavior below.
    const { spawnNonce: _acceptedRequestNonce, sessionId: _newSessionId, ...retained } = params.spawnOptions;
    return { ...retained, resume: quotaPreservation.nativeId, existingSessionId: params.sessionId };
  }
  const resolver = params.resolveAttachContext ?? resolveExistingSessionAttachContext;
  const storedCredentials = await params.readCredentials().catch(() => null);
  const effectiveCredentials = storedCredentials ?? params.credentials;
  const token = typeof effectiveCredentials?.token === 'string' ? effectiveCredentials.token.trim() : '';
  if (!token) return params.defaultOptions;
  const backendTarget = params.defaultOptions.backendTarget
    ?? params.spawnOptions.backendTarget
    ?? { kind: 'builtInAgent' as const, agentId: DEFAULT_CATALOG_AGENT_ID };

  const attachContext = await resolver({
    token,
    sessionId: params.sessionId,
    backendTarget,
    credentials: effectiveCredentials,
  }).catch(() => null);
  if (!attachContext?.ok) return params.defaultOptions;

  return resolveSessionRuntimeSnapshot({
    incomingOptions: params.defaultOptions,
    persistedMetadata: attachContext.metadata,
    trackedSpawnOptions: params.spawnOptions,
    persistedVendorResumeId: attachContext.vendorResumeId,
    trackedVendorResumeId: params.vendorResumeId,
  }).spawnOptions;
}
