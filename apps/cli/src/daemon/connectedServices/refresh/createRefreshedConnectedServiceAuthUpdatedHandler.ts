import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  ConnectedServiceSessionAuthSwitchAcquisitionError,
  type ConnectedServiceSessionAuthSwitchLockRegistry,
  type ConnectedServiceSessionAuthSwitchReason,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { logger } from '@/ui/logger';
import type { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

type OnAuthUpdated = NonNullable<
  ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']
>;
type AuthUpdatedEvent = Parameters<OnAuthUpdated>[0];

export type RefreshedConnectedServiceAuthApplication = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  activeProfileId: string | null;
  generation: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason: string;
  switchReason: ConnectedServiceSessionAuthSwitchReason;
  fromProfileId?: string | null;
}>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string }>>;

export type RefreshedAuthRestartRequiredDiagnostic = Readonly<{
  sessionId: string;
  pid: number;
  agentId: string;
  serviceId: string;
  profileId: string;
  errorCode: 'hot_apply_restart_required';
}>;

/** The per-session auth locks that the live application owner (`switchSessionConnectedServiceAuth`) takes. */
export type RefreshedConnectedServiceAuthSessionLocks = Pick<
  ConnectedServiceSessionAuthSwitchLockRegistry,
  'isHeldByAnotherOwner' | 'runExclusive' | 'runExclusiveDeferredBackground'
>;

type RefreshedConnectedServiceAuthApplicationInput = Parameters<RefreshedConnectedServiceAuthApplication>[0];
type RefreshedConnectedServiceAuthApplicationResult = Awaited<ReturnType<RefreshedConnectedServiceAuthApplication>>;

function isSameSessionSelection(
  current: ConnectedServiceChildSelection | null,
  applied: ConnectedServiceChildSelection,
): boolean {
  if (current === null) return false;
  if (current.kind === 'profile' && applied.kind === 'profile') return current.profileId === applied.profileId;
  if (current.kind === 'group' && applied.kind === 'group') {
    return current.groupId === applied.groupId
      && current.activeProfileId === applied.activeProfileId
      && current.generation === applied.generation;
  }
  return false;
}

/**
 * Applies a refreshed or reconnected credential to every running session bound to it, then hands
 * the event to the descriptor-driven restart handler.
 *
 * A session whose runtime cannot hot-apply the credential (`hot_apply_restart_required`) is left
 * to that restart handler instead of failing the whole event. Throwing here broke both callers for
 * as long as such a session ran: the account changes sync failed before saving its cursor and kept
 * retrying, and `/session-started` reconciliation (via `handleExternalCredentialUpdate`) answered
 * 503. What happens to the skipped session depends on its agent's lifecycle descriptor, exactly as
 * for any other refresh:
 * - Claude on `claude-subscription` needs no restart by design: its runners re-read the refreshed
 *   `.credentials.json` the daemon writes, and the descriptor exempts that service.
 * - Agents whose descriptor requires a restart get the handler's gated restart at a turn boundary.
 * - Codex (mode `hot_apply`), and OpenCode and Pi for the services their descriptors exempt, are
 *   NOT restarted: such a session keeps its previous credential. That was already so when this
 *   threw; it is now reported through `onRestartRequired` instead of looping.
 * Every other result keeps its previous handling: a session skipped under its execution policy
 * (`restart_disallowed_by_execution_policy`) is still skipped, and any other failure still throws.
 *
 * The handler never waits for a session auth lock that another transition holds. Incident
 * 2026-10-22: a runtime-auth recovery held session S's lock while it awaited this very application
 * for the rotation it had joined, and the application waited for S's lock; neither could finish.
 * A held session is therefore deferred: its application is queued on the session's lock, which
 * runs it after every transition already holding or awaiting that lock, and it is left out of the
 * returned applied identities. Nobody awaits that application, so its queued acquisition has no
 * 30-second bound (`runExclusiveDeferredBackground`): a slow but healthy holder does not drop it.
 * Only Stop or final child cleanup (`clearSession`) cancels it while queued; it then never applies.
 * Once it holds the lock it applies only if the session still has the selection this event
 * captured; a session that switched in the meantime keeps its own switch. The live application
 * owner's credential-revision check (`expectedCredentialRevisionByServiceId`) still rejects a
 * credential the server has since replaced. A deferred failure is logged and has no dedicated
 * retry. A transition already holding the lock in the calling async context re-enters it and
 * applies at once. Every free session's application is awaited, concurrently with the others, and
 * a failure among them still fails the notification.
 */
export function createRefreshedConnectedServiceAuthUpdatedHandler(params: Readonly<{
  applyRefreshedAuth: RefreshedConnectedServiceAuthApplication;
  restartAfterAuthUpdated: (event: AuthUpdatedEvent) => Promise<void>;
  onRestartRequired: (diagnostic: RefreshedAuthRestartRequiredDiagnostic) => void;
  sessionLocks: RefreshedConnectedServiceAuthSessionLocks;
  /** The session's current selection for the service, as its own switches last left it. */
  readCurrentSelection: (sessionId: string, serviceId: ConnectedServiceId) => ConnectedServiceChildSelection | null;
}>): OnAuthUpdated {
  const reportRestartRequired = (
    event: AuthUpdatedEvent,
    target: AuthUpdatedEvent['affectedTargets'][number],
    sessionId: string,
  ): void => {
    params.onRestartRequired({
      sessionId,
      pid: target.pid,
      agentId: target.agentId,
      serviceId: event.binding.serviceId,
      profileId: event.binding.profileId,
      errorCode: 'hot_apply_restart_required',
    });
  };

  const deferApplication = (input: Readonly<{
    event: AuthUpdatedEvent;
    target: AuthUpdatedEvent['affectedTargets'][number];
    selection: ConnectedServiceChildSelection;
    application: RefreshedConnectedServiceAuthApplicationInput;
  }>): void => {
    const { event, target, selection, application } = input;
    const logContext = {
      sessionId: application.sessionId,
      pid: target.pid,
      serviceId: event.binding.serviceId,
      profileId: event.binding.profileId,
      credentialRevision: event.credentialRevision ?? null,
      trigger: event.trigger,
    };
    logger.infoFile(
      '[ConnectedServiceRefresh] Refreshed credential application deferred: session auth lock is held',
      logContext,
    );
    void params.sessionLocks.runExclusiveDeferredBackground(application.sessionId, async () => {
      const currentSelection = params.readCurrentSelection(application.sessionId, event.binding.serviceId);
      if (!isSameSessionSelection(currentSelection, selection)) {
        logger.infoFile(
          '[ConnectedServiceRefresh] Deferred refreshed credential application dropped: session selection changed',
          logContext,
        );
        return;
      }
      const result: RefreshedConnectedServiceAuthApplicationResult = await params.applyRefreshedAuth(application);
      if (result.ok) {
        logger.infoFile('[ConnectedServiceRefresh] Deferred refreshed credential application completed', {
          ...logContext,
          action: result.action ?? null,
        });
        return;
      }
      if (result.errorCode === 'restart_disallowed_by_execution_policy') return;
      if (result.errorCode === 'hot_apply_restart_required') {
        reportRestartRequired(event, target, application.sessionId);
        return;
      }
      logger.warn('[ConnectedServiceRefresh] Deferred refreshed credential application failed', {
        ...logContext,
        errorCode: result.errorCode ?? 'unknown',
      });
    }).catch((error: unknown) => {
      if (error instanceof ConnectedServiceSessionAuthSwitchAcquisitionError && error.reason === 'session_stopped') {
        logger.infoFile(
          '[ConnectedServiceRefresh] Deferred refreshed credential application cancelled: session stopped',
          logContext,
        );
        return;
      }
      logger.warn('[ConnectedServiceRefresh] Deferred refreshed credential application failed', {
        ...logContext,
        error,
      });
    });
  };

  return async (event) => {
    if (event.mutation === 'deleted') {
      await params.restartAfterAuthUpdated(event);
      return { appliedRuntimeIdentityKeys: new Set<string>() };
    }

    // One attempt per session per notification, whether applied now or deferred.
    const attemptedSessionIds = new Set<string>();
    const applications: Promise<void>[] = [];
    const appliedRuntimeIdentityKeys = new Set<string>();
    for (const target of event.affectedTargets) {
      const sessionId = String(target.sessionId ?? '').trim();
      if (!sessionId || attemptedSessionIds.has(sessionId)) continue;
      const selection = target.selectionsByServiceId.get(event.binding.serviceId);
      if (!selection) continue;
      const activeProfileId = selection.kind === 'profile'
        ? selection.profileId
        : selection.activeProfileId;
      if (activeProfileId !== event.binding.profileId) continue;

      const application: RefreshedConnectedServiceAuthApplicationInput = {
        sessionId,
        serviceId: event.binding.serviceId,
        groupId: selection.kind === 'group' ? selection.groupId : null,
        activeProfileId,
        generation: selection.kind === 'group' ? selection.generation : null,
        credentialRevision: event.credentialRevision,
        reason: event.trigger,
        switchReason: 'automatic_runtime_failure',
        fromProfileId: activeProfileId,
      };
      attemptedSessionIds.add(sessionId);
      if (params.sessionLocks.isHeldByAnotherOwner(sessionId)) {
        deferApplication({ event, target, selection, application });
        continue;
      }
      applications.push((async () => {
        // Queue on the free lock at once, before this async function's first await, so no
        // transition arriving later can come between the check above and the application
        // owner's own acquisition (a re-entry for this context).
        const result = await params.sessionLocks.runExclusive(
          sessionId,
          async () => await params.applyRefreshedAuth(application),
        );
        if (!result.ok) {
          if (result.errorCode === 'restart_disallowed_by_execution_policy') return;
          if (result.errorCode === 'hot_apply_restart_required') {
            reportRestartRequired(event, target, sessionId);
            return;
          }
          throw new Error(`connected_service_refreshed_auth_application_failed:${result.errorCode ?? 'unknown'}`);
        }
        if (result.action !== 'hot_applied') return;
        for (const affectedTarget of event.affectedTargets) {
          if (
            affectedTarget.sessionId === sessionId
            && affectedTarget.pid === target.pid
          ) {
            appliedRuntimeIdentityKeys.add(affectedTarget.runtimeIdentityKey);
          }
        }
      })());
    }

    // Settle every awaited immediate application before failing the notification, so one
    // failure does not abandon the others. Held sessions were deferred above and are not awaited
    // here. Applying concurrently keeps one slow hot-apply from delaying the other sessions.
    const outcomes = await Promise.allSettled(applications);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;

    await params.restartAfterAuthUpdated(event);
    return { appliedRuntimeIdentityKeys };
  };
}
