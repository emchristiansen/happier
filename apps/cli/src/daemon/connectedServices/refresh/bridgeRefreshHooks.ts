import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type {
  BoundProfile,
  ConnectedServiceCredentialSource,
  SpawnTarget,
} from './refreshTypes';

export type OauthConnectedServiceCredentialRecord = Extract<
  ConnectedServiceCredentialRecordV1,
  { kind: 'oauth' }
>;

/**
 * CS-FIX-1: the coordinator-owned runtime capabilities a provider's bridge-refresh hook may use.
 *
 * The generic bridge-refresh skeleton (`ConnectedServiceRefreshCoordinator.refreshServiceTokensForBridge`)
 * owns the SHARED orchestration (authz choke point, F6 adopt-current-if-valid freshness decision,
 * positive-evidence runtime-state clear, forced distribution, rotation via `refreshOauthBinding`).
 * Everything a provider needs beyond that shared skeleton it reaches ONLY through this context, so
 * provider hooks never re-implement daemon internals and a new provider adds a hook module rather
 * than copy-pasting the skeleton into the coordinator.
 */
export type ConnectedServiceBridgeRefreshCapabilities = Readonly<{
  now: () => number;
  readCredentialSource: (binding: BoundProfile) => Promise<ConnectedServiceCredentialSource | null>;
  isOauthSourceStillValid: (source: ConnectedServiceCredentialSource) => boolean;
  resolveSourceExpiresAt: (source: ConnectedServiceCredentialSource) => number | null;
  rematerializeTargets: (binding: BoundProfile) => Promise<ReadonlyArray<SpawnTarget>>;
}>;

/**
 * The outcome of a provider's "can we serve a token WITHOUT rotating?" probe.
 * - `non_refreshable`: a long-lived credential (e.g. a Claude setup-token) — return it verbatim.
 * - `adoptable`: a currently-valid access token that MAY be adopted, subject to the shared force
 *   decision owned by the skeleton.
 * - `needs_refresh`: nothing directly returnable; the skeleton performs the forced rotation.
 */
export type ConnectedServiceBridgeCurrentTokenProbe<TResponse> =
  | Readonly<{ kind: 'non_refreshable'; accessToken: string; response: TResponse }>
  | Readonly<{ kind: 'adoptable'; accessToken: string; buildResponse: (selection?: ConnectedServiceChildSelection) => TResponse }>
  | Readonly<{ kind: 'needs_refresh' }>;

/**
 * The per-provider bridge-refresh hook. All three members are the provider-specific steps the
 * generic skeleton delegates: resolve the profile id from the authorized selection, probe for a
 * directly-servable current token, and shape the response from a freshly rotated OAuth credential
 * (including any provider-owned post-rotation materialization).
 */
export type ConnectedServiceBridgeRefreshProfileHooks<TResponse> = Readonly<{
  serviceId: ConnectedServiceId;
  resolveProfileId: (selection: ConnectedServiceChildSelection) => string;
  probeCurrentToken: (
    binding: BoundProfile,
  ) => Promise<ConnectedServiceBridgeCurrentTokenProbe<TResponse>>;
  finalizeRefreshedResponse: (input: Readonly<{
    binding: BoundProfile;
    selection: ConnectedServiceChildSelection;
    credential: OauthConnectedServiceCredentialRecord;
    credentialRevision: string;
  }>) => Promise<TResponse>;
}>;
