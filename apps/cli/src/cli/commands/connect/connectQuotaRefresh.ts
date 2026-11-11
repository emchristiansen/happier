import {
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';

/**
 * `happier connect quota-refresh` and `happier connect quota-status`: request, and observe, the
 * refresh of ONE connected-service profile's provider quota through the server's existing
 * exact-profile route, which the daemon's quota coordinator consumes like any other forced refresh.
 *
 * The profile is selected exactly (`--service` and `--profile`) before any access; nothing lists
 * profiles. The account's encryption mode, as the server states it (never inferred from a 404), picks
 * the route (V2 for e2ee, V3 for plain), since each route answers 404 for an account of the other mode. Only quota metadata is read; a sealed snapshot
 * is never opened. A recorded request is reported as pending until the profile's own metadata shows
 * the refresher fetched or failed after it.
 */
export type ConnectQuotaOperation = 'request' | 'status';

export type ConnectQuotaArgs = Readonly<{
  operation: ConnectQuotaOperation;
  serviceId: ConnectedServiceId;
  profileId: string;
  json: boolean;
}>;

export const CONNECT_QUOTA_SUBCOMMANDS: Readonly<Record<string, ConnectQuotaOperation>> = {
  'quota-refresh': 'request',
  'quota-status': 'status',
};

export const CONNECT_QUOTA_USAGE = 'Usage: happier connect quota-refresh|quota-status --service <service-id> --profile <profile-id> [--json]';

export function parseConnectQuotaArgs(subcommand: string, args: ReadonlyArray<string>): ConnectQuotaArgs {
  const operation = CONNECT_QUOTA_SUBCOMMANDS[subcommand];
  if (!operation) throw new Error(`Unknown quota subcommand: ${subcommand}`);
  let service: string | null = null;
  let profile: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--service' || arg === '--profile') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`Missing value for ${arg}. ${CONNECT_QUOTA_USAGE}`);
      if ((arg === '--service' ? service : profile) !== null) throw new Error(`${arg} given more than once. ${CONNECT_QUOTA_USAGE}`);
      if (arg === '--service') service = value; else profile = value;
      i += 1;
    } else {
      throw new Error(`Unexpected argument: ${arg}. ${CONNECT_QUOTA_USAGE}`);
    }
  }
  if (service === null || profile === null) throw new Error(`--service and --profile are required. ${CONNECT_QUOTA_USAGE}`);
  const serviceId = ConnectedServiceIdSchema.safeParse(service);
  if (!serviceId.success) throw new Error(`Unknown connected service id: ${service}`);
  const profileId = ConnectedServiceProfileIdSchema.safeParse(profile);
  if (!profileId.success) throw new Error(`Invalid profile id: ${profile}`);
  return { operation, serviceId: serviceId.data, profileId: profileId.data, json };
}

/** The quota metadata the server keeps for one profile; all times are epoch milliseconds. */
export type ConnectQuotaMetadata = Readonly<{
  fetchedAt: number;
  staleAfterMs: number;
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
  refreshRequestedAt?: number;
  refreshErrorAt?: number;
}>;

/**
 * Where the latest refresh request stands, from the profile's own metadata only (the server keeps no
 * queued or running state): `fetched` once a fetch completed at or after the request, `failed` once
 * the refresher recorded an error at or after it, `pending` before either. `quota_read_404` is a 404
 * from the metadata read; the existing quota-read client does not distinguish the route's own "not
 * found" from an absent route, so it says nothing about the profile, its source or the route.
 */
export type ConnectQuotaRefreshState =
  | Readonly<{ kind: 'quota_read_404' }>
  | Readonly<{ kind: 'no_request'; metadata: ConnectQuotaMetadata }>
  | Readonly<{ kind: 'pending'; metadata: ConnectQuotaMetadata }>
  | Readonly<{ kind: 'fetched'; metadata: ConnectQuotaMetadata }>
  | Readonly<{ kind: 'failed'; metadata: ConnectQuotaMetadata }>;

export function classifyConnectQuotaRefreshState(metadata: ConnectQuotaMetadata | null): ConnectQuotaRefreshState {
  if (!metadata) return { kind: 'quota_read_404' };
  const requestedAt = metadata.refreshRequestedAt;
  if (requestedAt === undefined || requestedAt <= 0) return { kind: 'no_request', metadata };
  if (metadata.fetchedAt >= requestedAt) return { kind: 'fetched', metadata };
  if (metadata.refreshErrorAt !== undefined && metadata.refreshErrorAt >= requestedAt) return { kind: 'failed', metadata };
  return { kind: 'pending', metadata };
}

export type ConnectQuotaCredential =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'found'; status: ConnectedServiceCredentialHealthStatusV1 }>;

export type ConnectQuotaResult =
  | Readonly<{
    outcome: 'refused';
    reason: 'account_encryption_mode_unknown' | 'credential_not_found' | 'credential_not_usable';
    credential: ConnectQuotaCredential | null;
  }>
  | Readonly<{
    outcome: 'request_not_found';
    accountEncryptionMode: 'e2ee' | 'plain';
    credential: ConnectQuotaCredential;
  }>
  | Readonly<{
    outcome: 'requested' | 'status';
    accountEncryptionMode: 'e2ee' | 'plain';
    credential: ConnectQuotaCredential;
    state: ConnectQuotaRefreshState;
  }>;

export type ConnectQuotaApi = Pick<
  ApiClient,
  | 'getConfirmedAccountEncryptionMode'
  | 'readConnectedServiceCredentialHealth'
  | 'requestConnectedServiceQuotaRefresh'
  | 'getConnectedServiceQuotaSnapshotSealed'
  | 'getConnectedServiceQuotaSnapshotPlain'
>;

async function readQuotaMetadata(api: ConnectQuotaApi, params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  mode: 'e2ee' | 'plain';
}>): Promise<ConnectQuotaMetadata | null> {
  const selector = { serviceId: params.serviceId, profileId: params.profileId };
  const read = params.mode === 'e2ee'
    ? await api.getConnectedServiceQuotaSnapshotSealed(selector)
    : await api.getConnectedServiceQuotaSnapshotPlain(selector);
  return read?.metadata ?? null;
}

/**
 * Run one quota operation for one exact profile. A request is refused, before anything is written,
 * when the account mode is unknown or the profile has no credential the refresher would use (it skips
 * profiles whose credential is not usable, so such a request would stay pending).
 */
export async function runConnectQuotaOperation(api: ConnectQuotaApi, args: Omit<ConnectQuotaArgs, 'json'>): Promise<ConnectQuotaResult> {
  const mode = await api.getConfirmedAccountEncryptionMode();
  if (mode === 'unknown') return { outcome: 'refused', reason: 'account_encryption_mode_unknown', credential: null };
  const selector = { serviceId: args.serviceId, profileId: args.profileId };
  const health = await api.readConnectedServiceCredentialHealth(selector);
  const credential: ConnectQuotaCredential = health.kind === 'found'
    ? { kind: 'found', status: health.status }
    : { kind: 'not_found' };

  if (args.operation === 'request') {
    if (credential.kind === 'not_found') return { outcome: 'refused', reason: 'credential_not_found', credential };
    if (!isConnectedServiceCredentialHealthStatusUsable(credential.status)) {
      return { outcome: 'refused', reason: 'credential_not_usable', credential };
    }
    const requested = await api.requestConnectedServiceQuotaRefresh({ ...selector, accountEncryptionMode: mode });
    if (requested === 'not_found') return { outcome: 'request_not_found', accountEncryptionMode: mode, credential };
  }
  const metadata = await readQuotaMetadata(api, { ...selector, mode });
  return {
    outcome: args.operation === 'request' ? 'requested' : 'status',
    accountEncryptionMode: mode,
    credential,
    state: classifyConnectQuotaRefreshState(metadata),
  };
}

/**
 * Exit status: 0 when the operation completed and reported a state (any state, including `pending`,
 * `failed` and `quota_read_404`: read the state, never the exit status, for the outcome); 2 when the
 * request was refused before writing or the refresh route answered `connect_quotas_not_found`.
 */
export function connectQuotaExitCode(result: ConnectQuotaResult): number {
  return result.outcome === 'requested' || result.outcome === 'status' ? 0 : 2;
}

function iso(ms: number | undefined): string | null {
  return ms === undefined || ms <= 0 ? null : new Date(ms).toISOString();
}

export function formatConnectQuotaResultJson(args: ConnectQuotaArgs, result: ConnectQuotaResult): string {
  const base = { serviceId: args.serviceId, profileId: args.profileId, operation: args.operation };
  if (result.outcome === 'refused' || result.outcome === 'request_not_found') {
    return JSON.stringify({ ...base, ...result });
  }
  const metadata = result.state.kind === 'quota_read_404' ? null : result.state.metadata;
  return JSON.stringify({
    ...base,
    outcome: result.outcome,
    accountEncryptionMode: result.accountEncryptionMode,
    credential: result.credential,
    state: result.state.kind,
    metadata: metadata && {
      ...metadata,
      fetchedAtIso: iso(metadata.fetchedAt),
      refreshRequestedAtIso: iso(metadata.refreshRequestedAt),
      refreshErrorAtIso: iso(metadata.refreshErrorAt),
    },
  });
}

export function formatConnectQuotaResultLines(args: ConnectQuotaArgs, result: ConnectQuotaResult): string[] {
  const subject = `${args.serviceId}/${args.profileId}`;
  if (result.outcome === 'refused') {
    const status = result.credential?.kind === 'found' ? ` (credential status: ${result.credential.status})` : '';
    return [`${subject}: refused, ${result.reason}${status}; nothing was requested`];
  }
  if (result.outcome === 'request_not_found') {
    return [`${subject}: the ${result.accountEncryptionMode} refresh route answered connect_quotas_not_found `
      + '(the account is not in that mode, or the profile has no quota source); nothing was recorded'];
  }
  const lines = [
    `${subject}: ${result.outcome === 'requested' ? 'refresh requested; ' : ''}state ${result.state.kind}`,
    `  account encryption: ${result.accountEncryptionMode}`,
    `  credential: ${result.credential.kind === 'found' ? result.credential.status : 'not found'}`,
  ];
  if (result.state.kind === 'quota_read_404') {
    lines.push('  quota metadata read returned 404; no profile, source or route conclusion follows');
  } else {
    const metadata = result.state.metadata;
    lines.push(`  refresh requested at: ${iso(metadata.refreshRequestedAt) ?? 'none'}`);
    lines.push(`  last fetch completed at: ${iso(metadata.fetchedAt) ?? 'never'}`);
    lines.push(`  last refresh error at: ${iso(metadata.refreshErrorAt) ?? 'none'}`);
    lines.push(`  snapshot status: ${metadata.status}`);
  }
  return lines;
}
