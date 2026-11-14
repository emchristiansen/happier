import {
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { ExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

import type { ConnectedServiceNativeSourceAuthority } from './materialize/providerMaterializerTypes';

declare const sessionContinuationBrand: unique symbol;

/**
 * Who names the native source a spawn's connected-service homes are produced from.
 *
 * - `new_caller`: the spawning caller's own environment (a direct launch, a fresh daemon spawn, a
 *   handoff, a probe or an execution run). A home recording a different source refuses it.
 * - `session_continuation`: a spawn that resumes an existing session the daemon itself read from
 *   the server, bound to that session's persisted materialization identity. Its homes were already
 *   produced, so they keep the source they record; the daemon's environment is never a source.
 *
 * Only `resolveExistingSessionSpawnNativeSource` makes a continuation, from the daemon's own
 * authenticated attach-context read; no spawn option, caller-supplied identity or flag can.
 */
export type ConnectedServiceSpawnNativeSource =
  | Readonly<{ kind: 'new_caller' }>
  | Readonly<{
      kind: 'session_continuation';
      sessionId: string;
      materializationIdentityId: string;
      readonly [sessionContinuationBrand]: true;
    }>;

export const NEW_CALLER_SPAWN_NATIVE_SOURCE: ConnectedServiceSpawnNativeSource = Object.freeze({ kind: 'new_caller' });

/** The spawn resumes an existing session under an identity other than the one it persisted. */
export class ConnectedServiceSpawnContinuationIdentityError extends Error {
  readonly code = 'connected_service_spawn_continuation_identity_mismatch';

  constructor(readonly sessionId: string, readonly persistedIdentityId: string, readonly spawnIdentityId: string | null) {
    super(
      `Session ${sessionId} persisted connected-service materialization identity ${persistedIdentityId}; `
        + `refusing to resume it under ${spawnIdentityId ?? 'no identity'}`,
    );
    this.name = 'ConnectedServiceSpawnContinuationIdentityError';
  }
}

/**
 * The native source of a spawn that resumes `existingSessionId`, from the daemon's own authenticated
 * read of that session (`resolveExistingSessionAttachContext`). A session whose metadata persisted a
 * materialization identity is a continuation of the homes produced under it, and the spawn must use
 * exactly that identity. A session that persisted none (produced before identities existed) is
 * re-produced by its caller, as before.
 */
export function resolveExistingSessionSpawnNativeSource(params: Readonly<{
  existingSessionId: string;
  attachContext: ExistingSessionAttachContext;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
}>): ConnectedServiceSpawnNativeSource {
  const persisted = readConnectedServiceMaterializationIdentityV1FromMetadata(params.attachContext.metadata);
  if (!persisted) return NEW_CALLER_SPAWN_NATIVE_SOURCE;
  if (params.materializationIdentity?.id !== persisted.id) {
    throw new ConnectedServiceSpawnContinuationIdentityError(
      params.existingSessionId,
      persisted.id,
      params.materializationIdentity?.id ?? null,
    );
  }
  return {
    kind: 'session_continuation',
    sessionId: params.existingSessionId,
    materializationIdentityId: persisted.id,
  } as ConnectedServiceSpawnNativeSource;
}

export function connectedServiceSpawnNativeSourceAuthority(
  source: ConnectedServiceSpawnNativeSource,
): ConnectedServiceNativeSourceAuthority {
  return source.kind === 'session_continuation' ? 'recorded' : 'caller_env';
}
