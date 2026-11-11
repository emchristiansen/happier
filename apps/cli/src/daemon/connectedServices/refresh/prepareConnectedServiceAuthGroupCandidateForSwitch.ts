import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceCredentialRefreshResult } from './refreshTypes';
import { isReauthRequiredFailure } from './refreshDiagnostics';

type CandidateRefreshService = Readonly<{
  refreshConnectedServiceCredentialForSpawnPreflight(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

export type ConnectedServiceAuthGroupCandidatePreparationResult =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'ineligible';
      memberState: Readonly<{
        credentialHealthStatus: 'needs_reauth' | 'refresh_failed_retryable';
      }>;
    }>;

/**
 * Proves credential viability before an automatic candidate is committed. The existing refresh
 * coordinator remains the single OAuth rotation/health owner; the switch coordinator remains the
 * single selector and CAS owner. Auth-class recovery validates forcibly, while other automatic
 * reasons use ordinary preflight so a healthy credential is a no-op.
 */
export async function prepareConnectedServiceAuthGroupCandidateForSwitch(input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  reason: string;
  refreshService: CandidateRefreshService;
}>): Promise<ConnectedServiceAuthGroupCandidatePreparationResult> {
  const refreshed = await input.refreshService.refreshConnectedServiceCredentialForSpawnPreflight({
    serviceId: input.serviceId,
    profileId: input.profileId,
    force: input.reason === 'auth_expired' || input.reason === 'refresh_failed',
  });
  switch (refreshed.status) {
    case 'refreshed':
    case 'not_needed':
    case 'not_oauth':
      return { status: 'ready' };
    case 'blocked_by_credential_health':
    case 'credential_missing':
      return {
        status: 'ineligible',
        memberState: { credentialHealthStatus: 'needs_reauth' },
      };
    case 'refresh_failed':
      return {
        status: 'ineligible',
        memberState: {
          credentialHealthStatus: isReauthRequiredFailure(refreshed.diagnostic.category ?? 'unknown')
            ? 'needs_reauth'
            : 'refresh_failed_retryable',
        },
      };
    case 'lease_not_acquired':
    case 'credential_health_unavailable':
      return {
        status: 'ineligible',
        memberState: { credentialHealthStatus: 'refresh_failed_retryable' },
      };
  }
}
