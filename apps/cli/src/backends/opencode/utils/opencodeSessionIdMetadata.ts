import type { Metadata } from '@/api/types';
import {
  buildOpenCodeAgentRuntimeDescriptor,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
} from '@happier-dev/agents';

export type OpenCodeSessionMetadataPublicationState = {
  sessionId: string | null;
  backendMode: 'server' | 'acp' | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
  managedServerLaunchFingerprint?: string | null;
  directStorageEnabled?: boolean;
};

export async function maybeUpdateOpenCodeSessionIdMetadata(params: {
  getOpenCodeSessionId: () => string | null;
  backendMode?: 'server' | 'acp' | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean | string | null;
  managedServerLaunchFingerprint?: string | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: OpenCodeSessionMetadataPublicationState;
}): Promise<void> {
  const raw = params.getOpenCodeSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  const backendMode = params.backendMode === 'acp' ? 'acp' : params.backendMode === 'server' ? 'server' : null;
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = serverBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const managedServerLaunchFingerprint = backendMode === 'server' && !serverBaseUrlExplicit
    ? params.managedServerLaunchFingerprint?.trim() || null : null;
  const directStorageEnabled = params.transcriptStorage === 'direct' && backendMode === 'server';
  if (
    params.lastPublished.sessionId === next &&
    params.lastPublished.backendMode === backendMode &&
    params.lastPublished.serverBaseUrl === serverBaseUrl &&
    params.lastPublished.serverBaseUrlExplicit === serverBaseUrlExplicit &&
    (params.lastPublished.managedServerLaunchFingerprint ?? null) === managedServerLaunchFingerprint &&
    params.lastPublished.directStorageEnabled === directStorageEnabled
  ) return;

  await params.updateHappySessionMetadata((metadata) => {
    const nextMetadata = { ...metadata } as Metadata & {
      opencodeServerBaseUrl?: string;
      opencodeServerBaseUrlExplicit?: true;
      opencodeManagedServerLaunchFingerprint?: unknown;
    };
    const runtimeDescriptor = nextMetadata.agentRuntimeDescriptorV1 as { providerId?: string } | undefined;
    if (!backendMode) {
      delete nextMetadata.opencodeBackendMode;
      if (runtimeDescriptor?.providerId === 'opencode') {
        delete nextMetadata.agentRuntimeDescriptorV1;
      }
    }
    if (!serverBaseUrl) {
      delete nextMetadata.opencodeServerBaseUrl;
      delete nextMetadata.opencodeServerBaseUrlExplicit;
    }
    // The descriptor is the current affinity tuple. Remove the predecessor top-level hint
    // so a backend/explicit-server transition cannot retain another server's custody.
    delete nextMetadata.opencodeManagedServerLaunchFingerprint;
    const runtimeDescriptorForSession = backendMode ? buildOpenCodeAgentRuntimeDescriptor({
      backendMode, vendorSessionId: next, serverBaseUrl, serverBaseUrlExplicit,
      managedServerLaunchFingerprint,
    }) : null;
    const updatedMetadata: Metadata = {
      ...nextMetadata,
      ...(backendMode ? {
        agentRuntimeDescriptorV1: runtimeDescriptorForSession!,
      } : {}),
      // Happy metadata field name. Value is OpenCode ACP sessionId (OpenCode uses sessionId as the stable resume id).
      opencodeSessionId: next,
      ...(backendMode ? { opencodeBackendMode: backendMode } : {}),
      ...(serverBaseUrl ? {
        opencodeServerBaseUrl: serverBaseUrl,
        opencodeServerBaseUrlExplicit: true,
      } : {}),
    };

    if (directStorageEnabled) {
      const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
      const directory = typeof metadata.path === 'string' ? metadata.path.trim() : '';
      if (machineId) {
        updatedMetadata.directSessionV1 = {
          v: 1,
          providerId: 'opencode',
          machineId,
          remoteSessionId: next,
          source: {
            kind: 'opencodeServer',
            ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
            ...(directory ? { directory } : {}),
          },
          linkedAtMs: Date.now(),
          agentRuntimeDescriptorV1: runtimeDescriptorForSession!,
        };
      }
    } else {
      delete updatedMetadata.directSessionV1;
    }

    return updatedMetadata;
  });

  params.lastPublished.sessionId = next;
  params.lastPublished.backendMode = backendMode;
  params.lastPublished.serverBaseUrl = serverBaseUrl;
  params.lastPublished.serverBaseUrlExplicit = serverBaseUrlExplicit;
  params.lastPublished.managedServerLaunchFingerprint = managedServerLaunchFingerprint;
  params.lastPublished.directStorageEnabled = directStorageEnabled;
}
