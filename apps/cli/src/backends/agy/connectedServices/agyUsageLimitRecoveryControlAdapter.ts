import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';

export function createAgyUsageLimitRecoveryControlAdapter(deps: Readonly<{ nowMs?: () => number; processEnv?: NodeJS.ProcessEnv }> = {}): SessionUsageLimitRecoveryControlAdapter {
  return createBackoffSessionUsageLimitRecoveryControlAdapter({
    providerId: 'agy', issueProviderFilter: 'agy', defaultNativeServiceId: 'antigravity',
    fallbackBackoffEnvKey: 'HAPPIER_AGY_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
    maxAttemptsEnvKey: 'HAPPIER_AGY_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
    ...deps,
  });
}
export const agyUsageLimitRecoveryControlAdapter = createAgyUsageLimitRecoveryControlAdapter();
