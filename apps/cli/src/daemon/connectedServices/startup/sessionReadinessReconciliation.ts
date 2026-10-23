import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type {
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetRegistration,
} from '../runtimeRegistry/registry';

/**
 * How long a runner's `/session-started` readiness waits for its connected-service reconciliation.
 * A daemon-started runner gives each report 10 s (`defaultReportAttemptTimeoutMs` in
 * `agent/runtime/startupSideEffects.ts`) and exits after 90 s without an answer. Half the attempt
 * leaves the rest for session intake, target registration and the answer itself.
 */
export const CONNECTED_SERVICE_SESSION_READINESS_WAIT_MS = 5_000;

/**
 * Pauses before re-running a reconciliation that failed after readiness answered. The first matches
 * the readiness wait; each failure doubles it, up to the longest, so a server outage costs each
 * registered runner one account-profile read per five minutes.
 */
export const CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS = Object.freeze({
  initialMs: 5_000,
  maxMs: 5 * 60_000,
});

/**
 * Owns a starting runner's readiness wait on its connected-service reconciliation.
 *
 * Readiness answers once the reconciliation succeeds, or after `waitMs` while it is still running;
 * a failure inside the wait fails readiness, and the runner reports again. A reconciliation readiness
 * stopped waiting for keeps running, and the target stays unreconciled until it succeeds (the
 * reconciliation records its projection epoch only after its live application). If it later fails,
 * this owner runs it again, with backoff, until one run succeeds or the registration is replaced.
 */
export function createConnectedServiceSessionReadinessReconciliation(deps: Readonly<{
  /** Runs the target's forced reconciliation, joining one already running. */
  reconcile: (registration: ConnectedServiceRuntimeTargetRegistration) => Promise<void>;
  isCurrent: (registration: ConnectedServiceRuntimeTargetRegistration) => boolean;
  waitMs?: number;
  retryDelayMs?: Readonly<{ initialMs: number; maxMs: number }>;
}>): (registration: ConnectedServiceRuntimeTargetRegistration) => Promise<void> {
  const waitMs = deps.waitMs ?? CONNECTED_SERVICE_SESSION_READINESS_WAIT_MS;
  const retryDelayMs = deps.retryDelayMs ?? CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS;
  const retryingTargets = new WeakSet<ConnectedServiceRuntimeTarget>();

  const logContext = (registration: ConnectedServiceRuntimeTargetRegistration) => ({
    key: registration.key,
    pid: registration.target.pid,
    sessionId: registration.target.sessionId,
  });

  const retryUntilReconciled = (
    registration: ConnectedServiceRuntimeTargetRegistration,
    unanswered: Promise<void>,
  ): void => {
    // One owner per target: a later run joins or follows the one this owner retries.
    if (retryingTargets.has(registration.target)) return;
    retryingTargets.add(registration.target);
    let nextDelayMs = retryDelayMs.initialMs;
    const follow = (attempt: Promise<void>): void => {
      attempt.then(() => {
        retryingTargets.delete(registration.target);
        logger.infoFile('[DAEMON RUN] Connected-service reconciliation settled after session readiness answered', logContext(registration));
      }, (error: unknown) => {
        if (!deps.isCurrent(registration)) {
          retryingTargets.delete(registration.target);
          return;
        }
        const delayMs = nextDelayMs;
        nextDelayMs = Math.min(nextDelayMs * 2, retryDelayMs.maxMs);
        logger.warn('[DAEMON RUN] Connected-service reconciliation failed after session readiness answered; retrying', {
          ...logContext(registration),
          retryInMs: delayMs,
          error: serializeAxiosErrorForLog(error),
        });
        const timer = setTimeout(() => {
          if (!deps.isCurrent(registration)) {
            retryingTargets.delete(registration.target);
            return;
          }
          follow(Promise.resolve().then(() => deps.reconcile(registration)));
        }, delayMs);
        timer.unref?.();
      });
    };
    follow(unanswered);
  };

  return async (registration) => {
    const reconciliation = deps.reconcile(registration);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      reconciliation.then(() => 'reconciled' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === 'reconciled') return;
    logger.warn('[DAEMON RUN] Session readiness answered before its connected-service reconciliation settled', {
      ...logContext(registration),
      waitMs,
    });
    retryUntilReconciled(registration, reconciliation);
  };
}
