import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  SessionConnectedServiceAuthApplyGenerationRequestV1,
  SessionConnectedServiceAuthCurrentGroupTruthV1,
} from '@happier-dev/protocol';
import type { AgentId as CatalogAgentId } from '@happier-dev/agents';

import type { ConnectedServiceSameAccountFanoutStrategy } from '../quotas/identity/providerFanoutStrategy';
import type { ConnectedServiceRuntimeRefreshTarget } from '../runtimeRegistry/target';

type LifecycleBoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

/**
 * Input for a provider's live-materialized-home staleness probe (RR-9). The generic refresh
 * coordinator gathers the runtime targets and store/canonical resolvers, then asks each
 * provider — via its lifecycle descriptor — whether a live materialized home no longer matches the
 * credential that owns it. This keeps the coordinator provider-agnostic: the Claude ownership rule
 * (canonical group active profile, fail-closed on unknown state) lives entirely in the Claude hook.
 */
export type ConnectedServiceMaterializedHomeStalenessInput = Readonly<{
  binding: LifecycleBoundProfile;
  targets: readonly ConnectedServiceRuntimeRefreshTarget[];
  activeServerDir: string;
  processEnv: NodeJS.ProcessEnv;
  now: number;
  refreshWindowMs: number;
  /** Resolves the CURRENT canonical active profile for a group (server state); null when unknown. */
  resolveCanonicalGroupActiveProfileId: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<string | null>;
  /** Resolves the CURRENT store access-token fingerprint for a profile; null when unavailable. */
  resolveStoreAccessTokenFingerprintForProfile: (profileId: string) => Promise<string | null>;
}>;

/**
 * Provider-owned live-home staleness probe consumed by the refresh coordinator.
 */
export type ConnectedServiceMaterializedHomeMaintenance = Readonly<{
  /** RR-9: is a live materialized home stale vs the owning credential? Absent ⇒ never stale. */
  hasStaleMaterializedHomeForBinding?: (
    input: ConnectedServiceMaterializedHomeStalenessInput,
  ) => Promise<boolean>;
}>;

export type ConnectedServiceRefreshReason =
  | 'scheduled'
  | 'spawn_preflight'
  | 'runtime_auth_failure'
  | 'manual_reconnect'
  | 'provider_auth_bridge'
  | 'quota_bridge';

export type ConnectedServiceRefreshFailureCategory =
  | 'invalid_grant'
  | 'invalid_client'
  | 'provider_401'
  | 'provider_403'
  | 'network_error'
  | 'malformed_response'
  | 'missing_access_token'
  | 'missing_refresh_token'
  | 'unknown';

export type ConnectedServicePredictiveSoftSwitchLiveSessionRequirement =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'shared_group_auth_surface';
      serviceIds: ReadonlyArray<ConnectedServiceId>;
      authEnvKey: string;
      authEnvSubpath?: ReadonlyArray<string>;
    }>;

export type ConnectedServiceRuntimeAuthApplyCapability = Readonly<{
  directLiveHotAuth:
    | 'unsupported'
    | Readonly<{
        supportsInTurnApply: boolean;
        requiresExactRuntimeIdentity: boolean;
        refreshSelectionResync: 'required' | 'not_applicable';
        authMode:
          | Readonly<{ kind: 'external_token_injection'; surface: string }>
          | Readonly<{ kind: 'managed_provider_session' }>
          | Readonly<{ kind: 'api_key' }>
          | Readonly<{ kind: 'provider_owned'; name: string }>;
      }>;
}>;

export type ConnectedServiceGenerationApplicationProofInput = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  credentialFingerprint?: string | null;
  environmentVariables: Readonly<Record<string, string>>;
}>;

export type ConnectedServiceGenerationApplicationProofResult =
  | Readonly<{
      status: 'verified';
      source: string;
      sharedAuthSurfaceId: string;
      credentialRevision: ConnectedServiceCredentialRevisionV1;
      credentialFingerprint: string;
    }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
      status: 'superseded_after_apply';
      activeProfileId: string;
      generation: number;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>;

export type ConnectedServiceSharedGenerationAuthoritativeTarget = Readonly<{
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

export type ConnectedServiceSharedGenerationMutationCurrentness = Readonly<
  | { current: true }
  | {
      current: false;
      authoritativeTarget?: ConnectedServiceSharedGenerationAuthoritativeTarget;
    }
>;

export const DEFAULT_CONNECTED_SERVICE_RUNTIME_AUTH_APPLY_CAPABILITY: ConnectedServiceRuntimeAuthApplyCapability = {
  directLiveHotAuth: 'unsupported',
};

export type ConnectedServiceCredentialStorageCleanupKind =
  | 'materialized_home'
  | 'materialized_attempt'
  | 'group_home_quarantine';

export type ConnectedServiceCredentialStorageCleanup = Readonly<{
  deleteCredentialStorageForHomeRoot(input: Readonly<{
    rootDir: string;
    kind: ConnectedServiceCredentialStorageCleanupKind;
  }>): Promise<void>;
}>;

/**
 * Every field here must have a production consumer; capability declarations without an enforcing
 * consumer are banned (they rot into false claims — see the removed `refreshTokenRuntimeHandling`,
 * whose `daemon_only` claim was contradicted by every materialization embedding the OAuth refresh
 * token, and `runtimeAuthFailureClassifier`, which no dispatch ever read).
 *
 * Current consumers:
 * - `spawnPreflightOauthRefresh` — `resolveConnectedServiceAuthForSpawn`.
 * - `refreshedCredentialApplication` — `createConnectedServicesAuthUpdatedRestartHandler`.
 * - `predictiveSoftSwitch` — `predictiveSoftSwitchPolicy` (spawn + daemon scheduling).
 * - `sameAccountFanoutStrategy` — `ConnectedServiceQuotasCoordinator` exact same-account fanout.
 * - `runtimeAuthApply` — central switch/fanout policy for in-turn direct-live eligibility
 *   and exact runtime identity/auth-mode requirements.
 * - `credentialStorageCleanup` — materialized/group-home cleanup schedulers.
 * - `materializedHomeMaintenance` — refresh coordinator live-staleness probe (RR-9).
 */
export type ConnectedServiceCredentialLifecycleDescriptor = Readonly<{
  providerId: CatalogAgentId;
  serviceIds: ReadonlyArray<ConnectedServiceId>;
  spawnPreflightOauthRefresh: Readonly<{
    mode: 'expiry_window' | 'force';
  }>;
  refreshedCredentialApplication: Readonly<{
    mode: 'restart_required' | 'hot_apply' | 'no_restart_required';
   /**
    * Service ids whose refreshed OAuth credential is consumed out-of-band by the runtime and therefore
    * must not trigger a process restart. Used for provider-owned brokers where the child holds only a
    * stable marker and asks the daemon for access tokens at request time.
    */
    noRestartRequiredServiceIds?: ReadonlyArray<ConnectedServiceId>;
    /**
     * Service ids whose refreshed OAuth credential is consumed through a daemon access-token callback
     * only when the resolved provider/runtime capability reports that callback as active. Unlike
     * `noRestartRequiredServiceIds`, targets without proof still restart/rematerialize.
     */
    noRestartRequiredWhenAccessTokenCallbackServiceIds?: ReadonlyArray<ConnectedServiceId>;
    /**
     * Service ids whose no-restart claim is credential-shape-specific: it holds ONLY when the running
     * session actually consumes the refreshed credential out-of-band (a broker marker) for the binding.
     * A session that baked a raw secret at spawn (e.g. a Pi `claude-subscription` SETUP-TOKEN, which
     * materializes as a direct `api_key` with no broker) still restarts so the reconnected credential
     * reaches the runtime. Evaluated via `isTargetBrokeredForBinding` against the tracked spawn env;
     * absent from `isTargetBrokeredForBinding` ⇒ treated as not brokered (fail toward restart).
     */
    noRestartRequiredWhenBrokeredServiceIds?: ReadonlyArray<ConnectedServiceId>;
    /**
     * Provider-owned predicate answering "does this running target hold a broker binding for
     * `serviceId`?" by reading its own broker markers off the tracked spawn environment. Required when
     * `noRestartRequiredWhenBrokeredServiceIds` is set; keeps the provider-specific broker knowledge in
     * the provider (the generic handler stays provider-agnostic).
     */
    isTargetBrokeredForBinding?: (input: Readonly<{
      serviceId: ConnectedServiceId;
      environmentVariables: Readonly<Record<string, string>>;
    }>) => boolean;
  }>;
  predictiveSoftSwitch: Readonly<{
    mode: 'supported' | 'unsupported';
    liveSessionRequirement?: ConnectedServicePredictiveSoftSwitchLiveSessionRequirement;
  }>;
  sameAccountFanoutStrategy: ConnectedServiceSameAccountFanoutStrategy;
  generationApplicationScope: 'per_session_runtime' | 'shared_group_auth_surface' | 'unsupported';
  /**
   * Exact services that share one live provider auth surface when the descriptor declares
   * `shared_group_auth_surface`. Missing membership fails back to per-session application.
   */
  sharedGenerationApplicationServiceIds?: ReadonlyArray<ConnectedServiceId>;
  runtimeAuthApply: ConnectedServiceRuntimeAuthApplyCapability;
  /**
   * Provider-owned proof that a live target already consumes the current group generation through
   * a stable shared auth surface. This is application proof, not a daemon spawn-intent assertion.
   */
  verifyGenerationApplication?: (
    input: ConnectedServiceGenerationApplicationProofInput,
  ) => Promise<ConnectedServiceGenerationApplicationProofResult>;
  /**
   * Applies one committed generation to a provider-owned shared auth surface without requiring a
   * representative runner. Providers declaring `shared_group_auth_surface` own this operation.
   */
  applySharedGenerationApplication?: (input: Readonly<{
    activeServerDir: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    record: ConnectedServiceCredentialRecordV1;
    validateCurrentBeforeMutation: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
  }>) => Promise<ConnectedServiceGenerationApplicationProofResult>;
  /**
   * Builds the retained session-RPC notification required by provider runtimes that cache group
   * auth. Request-time brokers omit this hook because they resolve server truth per request.
   */
  buildLiveGenerationCurrentTruthRequest?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    currentTruth: SessionConnectedServiceAuthCurrentGroupTruthV1;
    applicationSettled?: true;
  }>) => SessionConnectedServiceAuthApplyGenerationRequestV1;
  credentialStorageCleanup?: ConnectedServiceCredentialStorageCleanup;
  materializedHomeMaintenance?: ConnectedServiceMaterializedHomeMaintenance;
}>;

export function buildDefaultConnectedServiceCredentialLifecycleDescriptor(
  providerId: CatalogAgentId,
): ConnectedServiceCredentialLifecycleDescriptor {
  return {
    providerId,
    serviceIds: [],
    spawnPreflightOauthRefresh: { mode: 'expiry_window' },
    refreshedCredentialApplication: { mode: 'no_restart_required' },
    predictiveSoftSwitch: { mode: 'unsupported', liveSessionRequirement: { kind: 'none' } },
    sameAccountFanoutStrategy: 'none',
    generationApplicationScope: 'unsupported',
    runtimeAuthApply: DEFAULT_CONNECTED_SERVICE_RUNTIME_AUTH_APPLY_CAPABILITY,
  };
}
