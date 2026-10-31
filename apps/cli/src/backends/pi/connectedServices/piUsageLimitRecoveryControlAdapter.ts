import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';

const PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV =
  'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS' as const;
const PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV =
  'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS' as const;

export function createPiUsageLimitRecoveryControlAdapter(deps: Readonly<{
  nowMs?: () => number;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): SessionUsageLimitRecoveryControlAdapter {
  return createBackoffSessionUsageLimitRecoveryControlAdapter({
    providerId: 'pi',
    fallbackBackoffEnvKey: PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV,
    maxAttemptsEnvKey: PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV,
    ...deps,
  });
}

export const piUsageLimitRecoveryControlAdapter =
  createPiUsageLimitRecoveryControlAdapter();
