import type { TrackedSession } from '@/daemon/types';
import type { HotApplyRestartRequirement } from '../sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import type { RequiredAuthRestart } from './createConnectedServicesAuthUpdatedRestartHandler';
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
}>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string; restartRequirement?: HotApplyRestartRequirement }>>;

export type RefreshedAuthRestartRequiredDiagnostic = Readonly<{
  sessionId: string;
  pid: number;
  agentId: string;
  serviceId: string;
  profileId: string;
  errorCode: 'hot_apply_restart_required';
  restartRequirement?: HotApplyRestartRequirement;
  runtimeIdentityKey?: string;
  reason?: 'restart_target_identity_missing' | 'attempted_target_mismatch' | 'policy_refusal';
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
 * Applies refreshes without waiting for another auth-lock owner. Immediate and deferred
 * application completion hand actual adapter requirements to the existing restart owner.
 * Pre-side-effect policy refusals never become restart requirements. Held acquisitions remain
 * FIFO, cancellable by Stop, and unbounded only while nobody awaits their completion.
 */
export function createRefreshedConnectedServiceAuthUpdatedHandler(params: Readonly<{
  applyRefreshedAuth: RefreshedConnectedServiceAuthApplication;
  restartAfterAuthUpdated: (event: AuthUpdatedEvent & Readonly<{ requiredRestarts?: ReadonlyMap<number, RequiredAuthRestart> }>) => Promise<void>;
  captureRestartTarget?: (target: AuthUpdatedEvent['affectedTargets'][number]) => Readonly<{
    tracked: TrackedSession;
    isCurrent: (requirement: HotApplyRestartRequirement) => boolean | Promise<boolean>;
  }> | null;
  onRestartRequired: (diagnostic: RefreshedAuthRestartRequiredDiagnostic) => void;
  sessionLocks: RefreshedConnectedServiceAuthSessionLocks;
  /** The session's current selection for the service, as its own switches last left it. */
  readCurrentSelection: (sessionId: string, serviceId: ConnectedServiceId) => ConnectedServiceChildSelection | null;
}>): OnAuthUpdated {
  const reportRestartRequired = (
    event: AuthUpdatedEvent,
    target: AuthUpdatedEvent['affectedTargets'][number],
    sessionId: string,
    restartRequirement?: HotApplyRestartRequirement,
    reason?: RefreshedAuthRestartRequiredDiagnostic['reason'],
  ): void => {
    params.onRestartRequired({
      sessionId,
      pid: target.pid,
      agentId: target.agentId,
      serviceId: event.binding.serviceId,
      profileId: event.binding.profileId,
      errorCode: 'hot_apply_restart_required',
      ...(restartRequirement ? { restartRequirement, runtimeIdentityKey: target.runtimeIdentityKey } : {}),
      ...(reason ? { reason } : !restartRequirement ? { reason: 'policy_refusal' as const } : {}),
    });
  };

  type ApplicationContext = Readonly<{
    event: AuthUpdatedEvent;
    target: AuthUpdatedEvent['affectedTargets'][number];
    selection: ConnectedServiceChildSelection;
    application: RefreshedConnectedServiceAuthApplicationInput;
    captured: ReturnType<NonNullable<typeof params.captureRestartTarget>>;
  }>;

  const handOffRequirement = async (context: ApplicationContext, requirement: HotApplyRestartRequirement): Promise<void> => {
    const { event, target, application, captured } = context;
    const sameAttempt = requirement.serviceId === application.serviceId
      && requirement.profileId === application.activeProfileId
      && requirement.groupId === application.groupId
      && requirement.generation === application.generation
      && (application.credentialRevision == null || requirement.credentialRevision === application.credentialRevision);
    if (!sameAttempt || !captured) {
      reportRestartRequired(event, target, application.sessionId, requirement,
        !sameAttempt ? 'attempted_target_mismatch' : 'restart_target_identity_missing');
      return;
    }
    reportRestartRequired(event, target, application.sessionId, requirement);
    await params.restartAfterAuthUpdated({
      ...event,
      affectedTargets: [target],
      requiredRestarts: new Map([[target.pid, {
        requirement, tracked: captured.tracked, sessionId: application.sessionId,
        runtimeIdentityKey: target.runtimeIdentityKey,
        isCurrent: () => captured.isCurrent(requirement),
      }]]),
    });
  };

  const deferApplication = (context: ApplicationContext): void => {
    const { event, target, selection, application } = context;
    const logContext = {
      sessionId: application.sessionId, pid: target.pid, serviceId: event.binding.serviceId,
      profileId: event.binding.profileId, credentialRevision: event.credentialRevision ?? null, trigger: event.trigger,
    };
    logger.infoFile('[ConnectedServiceRefresh] Refreshed credential application deferred: session auth lock is held', logContext);
    void params.sessionLocks.runExclusiveDeferredBackground(application.sessionId, async () => {
      const current = params.readCurrentSelection(application.sessionId, event.binding.serviceId);
      if (!isSameSessionSelection(current, selection)) {
        logger.infoFile('[ConnectedServiceRefresh] Deferred refreshed credential application dropped: session selection changed', logContext);
        return null;
      }
      return await params.applyRefreshedAuth(application);
    }).then(async (result) => {
      // The acquired operation has unwound. A later queued owner may already be running;
      // the captured requirement therefore still needs its final currentness gate.
      if (!result) return;
      if (!result.ok && result.restartRequirement) {
        await handOffRequirement(context, result.restartRequirement);
      } else if (result.ok) {
        logger.infoFile('[ConnectedServiceRefresh] Deferred refreshed credential application completed', { ...logContext, action: result.action ?? null });
        await params.restartAfterAuthUpdated({ ...event, affectedTargets: [target] });
      } else if (result.errorCode === 'hot_apply_restart_required') {
        reportRestartRequired(event, target, application.sessionId);
      } else if (result.errorCode !== 'restart_disallowed_by_execution_policy') {
        logger.warn('[ConnectedServiceRefresh] Deferred refreshed credential application failed', { ...logContext, errorCode: result.errorCode ?? 'unknown' });
      }
    }).catch((error: unknown) => {
      if (error instanceof ConnectedServiceSessionAuthSwitchAcquisitionError && error.reason === 'session_stopped') {
        logger.infoFile('[ConnectedServiceRefresh] Deferred refreshed credential application cancelled: session stopped', logContext);
        return;
      }
      logger.warn('[ConnectedServiceRefresh] Deferred refreshed credential application failed', { ...logContext, error });
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
    const excludedFromGenericRestart = new Set<string>();
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
      const context: ApplicationContext = { event, target, selection, application, captured: params.captureRestartTarget?.(target) ?? null };
      if (params.sessionLocks.isHeldByAnotherOwner(sessionId)) {
        excludedFromGenericRestart.add(sessionId);
        deferApplication(context);
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
          if (result.restartRequirement) {
            excludedFromGenericRestart.add(sessionId);
            await handOffRequirement(context, result.restartRequirement);
            return;
          }
          if (result.errorCode === 'restart_disallowed_by_execution_policy') {
            excludedFromGenericRestart.add(sessionId);
            return;
          }
          if (result.errorCode === 'hot_apply_restart_required') {
            excludedFromGenericRestart.add(sessionId);
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

    const genericTargets = event.affectedTargets.filter((target) => !excludedFromGenericRestart.has(String(target.sessionId ?? '').trim()));
    if (genericTargets.length > 0) await params.restartAfterAuthUpdated({ ...event, affectedTargets: genericTargets });
    return { appliedRuntimeIdentityKeys };
  };
}
