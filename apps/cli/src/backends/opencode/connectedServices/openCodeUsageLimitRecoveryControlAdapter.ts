import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';

const OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV =
  'HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS' as const;
const OPENCODE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV =
  'HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS' as const;

export function createOpenCodeUsageLimitRecoveryControlAdapter(deps: Readonly<{
  nowMs?: () => number;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): SessionUsageLimitRecoveryControlAdapter {
  return createBackoffSessionUsageLimitRecoveryControlAdapter({
    providerId: 'opencode',
    fallbackBackoffEnvKey: OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV,
    maxAttemptsEnvKey: OPENCODE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV,
    ...deps,
  });
}

export const openCodeUsageLimitRecoveryControlAdapter =
  createOpenCodeUsageLimitRecoveryControlAdapter();
