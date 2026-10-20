import type { Credentials } from '@/persistence';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';

import { continueTrackedTemporaryThrottleSession } from '../temporaryThrottle/continueTrackedTemporaryThrottleSession';
import type { TemporaryThrottleResumeSource } from '../temporaryThrottle/resolveInactiveTemporaryThrottleResumeSource';
import type { RuntimeAuthLimitResetRetryInput, RuntimeAuthLimitResetRetryResult } from './RuntimeAuthRecoveryScheduler';

type ResumeDependencies = Parameters<typeof continueTrackedTemporaryThrottleSession>[0];

/** Submit new provider work through the existing runner and Pending owners. */
export async function retryRuntimeAuthLimitAfterReset(input: RuntimeAuthLimitResetRetryInput & Readonly<{
  resolveResumeSource: (sessionId: string) => Promise<TemporaryThrottleResumeSource | null>;
  credentials: Credentials;
  readCredentials: ResumeDependencies['readCredentials'];
  spawnSession: ResumeDependencies['spawnSession'];
  resolveRespawnOptions?: ResumeDependencies['resolveRespawnOptions'];
  sendMessage?: typeof sendSessionMessage;
  customResumePrompt: string | null;
}>): Promise<RuntimeAuthLimitResetRetryResult> {
  if (!input.isCurrent()) return { status: 'deferred' };
  if (input.resumePromptMode === 'off') {
    return { status: 'terminal', lastError: 'limit_reset_continuation_disabled' };
  }
  const tracked = await input.resolveResumeSource(input.sessionId);
  if (!input.isCurrent()) return { status: 'deferred' };
  if (!tracked) return { status: 'terminal', lastError: 'limit_reset_session_not_found' };
  const assertCurrent = () => {
    if (!input.isCurrent()) throw new Error('limit_reset_recovery_no_longer_current');
  };
  try {
    const result = await continueTrackedTemporaryThrottleSession({
      tracked, sessionId: input.sessionId, credentials: input.credentials, readCredentials: input.readCredentials,
      ...(input.resolveRespawnOptions ? { resolveRespawnOptions: input.resolveRespawnOptions } : {}),
      spawnSession: async (options) => { assertCurrent(); return await input.spawnSession(options); },
      sendMessage: async (request) => { assertCurrent(); return await (input.sendMessage ?? sendSessionMessage)(request); },
      // Pending identifies this claimed provider trial; later trials use a new identity.
      attemptId: `${input.attemptId}:limit-reset:${input.retryCount}`,
      continuation: {
        interruptedOriginId: input.attemptId,
        resumePromptMode: input.resumePromptMode,
        customResumePrompt: input.customResumePrompt,
        recoveryKind: input.classification.kind,
      },
    });
    if (result.status !== 'runtime_unavailable') return result;
    throw new Error(`limit_reset_resume_unavailable:${result.runtimeResult.reason}`);
  } catch (error) {
    if (!input.isCurrent()) return { status: 'deferred' };
    throw error;
  }
}
