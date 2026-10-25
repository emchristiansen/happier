import type { Credentials } from '@/persistence';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';

import { continueTrackedTemporaryThrottleSession } from '../temporaryThrottle/continueTrackedTemporaryThrottleSession';
import type { TemporaryThrottleResumeSource } from '../temporaryThrottle/resolveInactiveTemporaryThrottleResumeSource';
import {
  ConnectedServiceSessionAuthSwitchAcquisitionError,
  type ConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import type { RuntimeAuthFailureSourceAuthorization } from './handleConnectedServiceRuntimeAuthFailureForSession';
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
  authorizeSource: () => Promise<RuntimeAuthFailureSourceAuthorization>;
  switchCore: ConnectedServiceSessionAuthSwitchCore;
}>): Promise<RuntimeAuthLimitResetRetryResult> {
  let entered = false;
  try {
    return await runWithinSessionLane(input, () => { entered = true; });
  } catch (error) {
    // A queued acquisition cancelled before this callback ran made no attempt:
    // defer so the scheduler rolls back this unattempted trial. An acquisition
    // error raised inside an executing callback is that callback's failure.
    if (!entered && isPreEntryAcquisitionCancellation(error, input.sessionId)) return { status: 'deferred' };
    throw error;
  }
}

function isPreEntryAcquisitionCancellation(error: unknown, sessionId: string): boolean {
  if (!(error instanceof ConnectedServiceSessionAuthSwitchAcquisitionError) || error.sessionId !== sessionId) return false;
  switch (error.reason) {
    case 'timed_out':
    case 'session_stopped':
      // Explicit Stop also cancels the recovery durably, which this deferral
      // cannot undo; normal final-child cleanup leaves it to retry later.
      return true;
    default:
      return error.reason satisfies never;
  }
}

async function runWithinSessionLane(
  input: Parameters<typeof retryRuntimeAuthLimitAfterReset>[0],
  onEntered: () => void,
): Promise<RuntimeAuthLimitResetRetryResult> {
  return await input.switchCore.run({ sessionId: input.sessionId, reason: 'automatic_runtime_failure', execute: async () => {
    onEntered();
    if (!input.isCurrent()) return { status: 'deferred' };
    if (input.resumePromptMode === 'off') {
      return { status: 'terminal', lastError: 'limit_reset_continuation_disabled' };
    }
    const authorization = await input.authorizeSource();
    if (!input.isCurrent()) return { status: 'deferred' };
    if (authorization.status === 'recovery_superseded') return { status: 'superseded', reason: authorization.reason };
    const tracked = await input.resolveResumeSource(input.sessionId);
    if (!input.isCurrent()) return { status: 'deferred' };
    if (!tracked) return { status: 'terminal', lastError: 'limit_reset_session_not_found' };
    let admissionStarted = false;
    const assertCurrent = () => {
      if (!input.isCurrent()) throw new Error('limit_reset_recovery_no_longer_current');
    };
    try {
      const result = await continueTrackedTemporaryThrottleSession({
        tracked, sessionId: input.sessionId, credentials: input.credentials, readCredentials: input.readCredentials,
        ...(input.resolveRespawnOptions ? { resolveRespawnOptions: input.resolveRespawnOptions } : {}),
        spawnSession: async (options) => { assertCurrent(); return await input.spawnSession(options); },
        ...(input.preserveAdmission ? { preserveAdmission: input.preserveAdmission } : {}),
        assertCanAdmit: () => { assertCurrent(); admissionStarted = true; },
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
      // Cancellation cannot revoke a request already sent. Preserve that trial's
      // custody and identity even if disposal occurs while its ACK is in flight.
      if (admissionStarted) return { status: 'admission_unconfirmed' };
      if (!input.isCurrent()) return { status: 'deferred' };
      throw error;
    }
  } });
}
