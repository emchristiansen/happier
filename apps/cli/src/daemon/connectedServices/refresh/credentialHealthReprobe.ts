import type { ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol';

import type { ConnectedServiceRefreshReason } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import type { BoundProfile } from './refreshTypes';

export type CredentialHealthReprobeState = Readonly<{
  failureCount: number;
  nextProbeAt: number;
}>;

const CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

export function shouldBlockRefreshForCredentialHealth(reason: ConnectedServiceRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'provider_auth_bridge'
    || reason === 'quota_bridge';
}

export function canReprobeCredentialHealth(
  reason: ConnectedServiceRefreshReason,
  options: Readonly<{ force: boolean }>,
): boolean {
  if (options.force) return true;
  return reason === 'scheduled' || reason === 'quota_bridge';
}

export function credentialHealthReprobeDelayMs(failureCount: number): number {
  const index = Math.max(0, Math.min(
    CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS.length - 1,
    Math.trunc(failureCount),
  ));
  return CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS[index]!;
}

/**
 * The bound profile's credential health as the refresh path may act on it. Health that could not be
 * read is `unavailable`, never an implied healthy status: an older server without the exact route,
 * a malformed response, a transport failure, a client without the reader, or a profile that vanished
 * after its credential was read.
 */
export type CredentialHealthForRefresh =
  | Readonly<{ kind: 'read'; status: ConnectedServiceCredentialHealthStatusV1 }>
  | Readonly<{ kind: 'unavailable' }>;

/** Reads the bound profile's health by its exact key, so no other profile of the service is read. */
export async function readCredentialHealthForRefresh(input: Readonly<{
  api: Pick<ApiClient, 'readConnectedServiceCredentialHealth'>;
  binding: BoundProfile;
}>): Promise<CredentialHealthForRefresh> {
  try {
    const health = await input.api.readConnectedServiceCredentialHealth({
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
    });
    if (health.kind === 'found') return { kind: 'read', status: health.status };
    logger.warn('[DAEMON RUN] Connected-service profile health is absent before refresh', {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
    });
    return { kind: 'unavailable' };
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to read connected-service profile health before refresh', {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      error: serializeAxiosErrorForLog(error),
    });
    return { kind: 'unavailable' };
  }
}
