import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type {
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetRegistration,
} from '../runtimeRegistry/registry';

/**
 * How long a runner's `/session-started` readiness waits for its connected-service reconciliation.
 * By default, the daemon bounds readiness answers at 20 s (`sessionStartedReadiness.ts`), and a
 * daemon-started runner uses 30 s HTTP attempts (`agent/runtime/startupSideEffects.ts`). A runner
 * requiring acknowledgement has a ten-minute hard ceiling while receiving readiness answers and
 * a 90 s retry window without them; its attempt timeout and retry window can be configured.
 * This five-second wait leaves room for the rest of readiness handling. It does not bound session
 * intake, target registration or the whole HTTP round trip.
 */
export const CONNECTED_SERVICE_SESSION_READINESS_WAIT_MS = 5_000;

/**
 * Pauses before re-running a reconciliation that failed after readiness answered. The first matches
 * the readiness wait; each failure doubles it (5 s, 10 s, 20 s, …) up to the longest. Through a
 * server outage this owner's retries for one runner thus settle at one account-profile read per five
 * minutes; other producers read the account profile on their own schedules.
 */
export const CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS = Object.freeze({
  initialMs: 5_000,
  maxMs: 5 * 60_000,
});

/**
 * Owns a starting runner's readiness wait on its connected-service reconciliation.
 *
 * Readiness answers when raw reconciliation fulfills, or after `waitMs` while it is still running;
 * rejection inside the wait fails readiness, and the runner reports again. Raw reconciliation keeps
 * running after readiness stops waiting. A target's projection epoch is recorded only after the
 * handlers reconciliation awaits complete without rejection, not as proof of credential adoption.
 * Later work can remain outside that promise: a foreign-held auth lock queues application for later;
 * a handled failed-adapter typed restart requirement hands control to the canonical restart owner
 * without awaiting a turn boundary, signal, retirement or respawn. Either later path can fail or be
 * suppressed after raw reconciliation fulfills, unseen here. The daemon WeakMap cleanup and this
 * helper's retries observe only the actual raw promise's settlement or rejection, not that later work.
 * If raw reconciliation rejects after readiness answered, this owner runs it again, with backoff,
 * until a run fulfills, the registration is replaced, or daemon shutdown begins. Shutdown stops new
 * runs only; a run already in progress is not cancelled.
 */
export function createConnectedServiceSessionReadinessReconciliation(deps: Readonly<{
  /**
   * Runs or joins the target's forced reconciliation. Readiness calls and retries share its raw
   * promise until it settles.
   */
  reconcile: (registration: ConnectedServiceRuntimeTargetRegistration) => Promise<void>;
  isCurrent: (registration: ConnectedServiceRuntimeTargetRegistration) => boolean;
  /** True once daemon shutdown has begun: no new retry is admitted after that. */
  isShuttingDown: () => boolean;
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
        if (deps.isShuttingDown() || !deps.isCurrent(registration)) {
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
          if (deps.isShuttingDown() || !deps.isCurrent(registration)) {
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
