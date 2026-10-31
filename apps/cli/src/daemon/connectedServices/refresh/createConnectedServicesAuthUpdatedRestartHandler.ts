import type { HotApplyRestartRequirement } from '../sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { observeConnectedServiceAuthStage } from '../runtimeAuth/observeConnectedServiceAuthStage';
import type { ConnectedServiceId, StopSessionResult } from '@happier-dev/protocol';
import type {
  ConnectedServiceDaemonRestartDiagnosticInput,
  ConnectedServiceDaemonRestartDiagnosticRecorder,
  ConnectedServiceDaemonRestartTrigger,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

type ConnectedServiceBindingRef = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
  generation?: number;
}>;

type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  accessTokenRefresh?: Readonly<{
    mode: 'daemon_callback';
    serviceIds: ReadonlyArray<ConnectedServiceId>;
  }> | null;
}>;

/** Refresh-local ownership evidence; never part of the public FSM/wire result. */
export type RequiredAuthRestart = Readonly<{
  requirement: HotApplyRestartRequirement;
  tracked: TrackedSession;
  sessionId: string;
  runtimeIdentityKey: string;
  isCurrent: () => boolean | Promise<boolean>;
}>;

export type ConnectedServicesAuthUpdatedRestartBlockedDiagnostic = Readonly<{
  serviceId: string;
  profileId: string;
  agentId: CatalogAgentId;
  pid: number;
  reason:
    | 'tracked_session_missing'
    | 'not_daemon_started'
    | 'unsupported_restart_signal'
    | 'service_unsupported'
    | 'restart_disabled'
    | 'stale_restart_requirement'
    | 'restart_requirement_currentness_unproven'
    | 'restart_requirement_identity_missing'
    | 'restart_not_signaled'
    | 'restart_request_failed';
  restartRequirement?: HotApplyRestartRequirement;
  notSignaledReason?: string;
  startedBy: string | null;
  hasChildProcess: boolean;
  hasProcessGroupPid: boolean;
  reattachedFromDiskMarker: boolean;
}>;

export class ConnectedServiceCredentialDeletionNotSettledError extends Error {
  constructor(
    readonly target: ConnectedServiceSpawnTargetRef,
    readonly binding: ConnectedServiceBindingRef,
    readonly stopResult: StopSessionResult | null,
  ) {
    super('connected_service_credential_deletion_not_settled');
    this.name = 'ConnectedServiceCredentialDeletionNotSettledError';
  }
}

function normalizeGroupGeneration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function resolveConnectedServiceBindingGroupMetadata(input: Readonly<{
  tracked: TrackedSession;
  binding: ConnectedServiceBindingRef;
}>): Readonly<{ groupId: string | null; generation: number | null }> {
  const explicitGroupId = typeof input.binding.groupId === 'string' && input.binding.groupId.trim()
    ? input.binding.groupId.trim()
    : '';
  const explicitGeneration = normalizeGroupGeneration(input.binding.generation);
  if (explicitGroupId || explicitGeneration !== null) {
    return {
      groupId: explicitGroupId || null,
      generation: explicitGeneration,
    };
  }

  const selections = readConnectedServiceChildSelectionsFromEnv(
    input.tracked.spawnOptions?.environmentVariables ?? {},
  );
  const groupSelection = selections.find((selection) =>
    selection.kind === 'group'
    && selection.serviceId === input.binding.serviceId
    && selection.activeProfileId === input.binding.profileId
  );
  if (!groupSelection || groupSelection.kind !== 'group') {
    return { groupId: null, generation: null };
  }

  return {
    groupId: groupSelection.groupId,
    generation: normalizeGroupGeneration(groupSelection.generation),
  };
}

export function createConnectedServicesAuthUpdatedRestartHandler(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  resolveLifecycleDescriptor: (agentId: CatalogAgentId) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;
  /**
   * K3: the handler hands the resolved tracked session, its session id, and the
   * gated-restart target descriptor to this dependency in addition to the raw
   * pid/signal fields. The daemon wires this to the gated restart primitive
   * (requestConnectedServiceRestartWithDeferral) so a credential-refresh /
   * reconnect restart inherits turn-deferral + the spawn-time reachability gate
   * instead of sending a raw mid-turn SIGTERM. This canonical dependency owns
   * restartRequestedPids; this handler never reserves or releases its intent.
   */
  requestRestartSignal: (params: Readonly<{
    pid: number;
    tracked: TrackedSession;
    sessionId: string | null;
    target: Readonly<{
      serviceId: string;
      profileId: string;
      groupId: string;
      generation: number | null;
      credentialRevision?: string;
    }>;
    processGroupPid?: number | null;
    delayMs: number;
    shouldSignal?: () => boolean | Promise<boolean>;
    onSignalFailure: (error: unknown) => void;
    restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    nowMs?: () => number;
    /**
     * Reports whether a restart signal was ACTUALLY emitted. The gated restart dependency can
     * resolve successfully WITHOUT signalling (e.g. the deferred restart was superseded by a newer
     * switch — `switch_cancelled`, or joined a queued manual request). A joined caller's false
     * result must not release the executing owner's reservation. Pending requests coalesce in the
     * existing deferral queue; the canonical dependency owns signal reservation and cleanup.
     */
  }>) => Promise<Readonly<{ signaled: boolean; notSignaledReason?: string }>>;
  stopSessionForCredentialDeletion?: (input: Readonly<{
    tracked: TrackedSession;
    target: ConnectedServiceSpawnTargetRef;
    binding: ConnectedServiceBindingRef;
  }>) => StopSessionResult | Promise<StopSessionResult>;
  restartEnabled?: boolean;
  resolveProcessGroupPid: (tracked: TrackedSession) => number | null;
  restartSignalDelayMs: number;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
  nowMs?: () => number;
  onRestartSignalFailure?: (error: unknown, target: ConnectedServiceSpawnTargetRef) => void;
  onRestartBlocked?: (diagnostic: ConnectedServicesAuthUpdatedRestartBlockedDiagnostic) => void;
}>): (event: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  requiredRestarts?: ReadonlyMap<number, RequiredAuthRestart>;
  mutation?: 'replaced' | 'deleted';
  trigger?: Extract<ConnectedServiceDaemonRestartTrigger, 'refresh_triggered_restart' | 'reconnect_propagation'>;
}>) => Promise<void> {
  return async (event) => {
    const trigger = event.trigger ?? 'refresh_triggered_restart';
    const emitBlocked = (
      target: ConnectedServiceSpawnTargetRef,
      tracked: TrackedSession | null,
      processGroupPid: number | null,
      reason: ConnectedServicesAuthUpdatedRestartBlockedDiagnostic['reason'],
      notSignaledReason?: string,
    ) => {
      params.onRestartBlocked?.({
        serviceId: event.binding.serviceId,
        profileId: event.binding.profileId,
        agentId: target.agentId,
        pid: target.pid,
        reason,
        ...(event.requiredRestarts?.get(target.pid) ? { restartRequirement: event.requiredRestarts.get(target.pid)!.requirement } : {}),
        ...(notSignaledReason ? { notSignaledReason } : {}),
        startedBy: tracked?.startedBy ?? null,
        hasChildProcess: Boolean(tracked?.childProcess),
        hasProcessGroupPid: processGroupPid !== null,
        reattachedFromDiskMarker: Boolean(tracked?.reattachedFromDiskMarker),
      });
    };

    for (const target of event.affectedTargets) {
      const tracked = params.pidToTrackedSession.get(target.pid);
      if (event.mutation === 'deleted') {
        if (!tracked) {
          emitBlocked(target, null, null, 'tracked_session_missing');
          throw new ConnectedServiceCredentialDeletionNotSettledError(target, event.binding, null);
        }
        if (!params.stopSessionForCredentialDeletion) {
          throw new Error('Credential deletion lifecycle owner is not configured');
        }
        const stopResult = await params.stopSessionForCredentialDeletion({
          tracked,
          target,
          binding: event.binding,
        });
        if (stopResult.status === 'stopped') continue;
        if (
          stopResult.status === 'not_found'
          && params.pidToTrackedSession.get(target.pid) !== tracked
        ) continue;
        throw new ConnectedServiceCredentialDeletionNotSettledError(
          target,
          event.binding,
          stopResult,
        );
      }
      const required = event.requiredRestarts?.get(target.pid);
      const capturedOwnerIsCurrent = () => Boolean(required
        && params.pidToTrackedSession.get(target.pid) === required.tracked
        && tracked === required.tracked
        && required.tracked.pid === target.pid
        && required.tracked.happySessionId === required.sessionId
        && required.tracked.childProcess?.exitCode == null
        && required.tracked.childProcess?.signalCode == null);
      const requirementIsCurrent = async (): Promise<boolean> => {
        if (!required) return params.pidToTrackedSession.get(target.pid) === tracked;
        if (!capturedOwnerIsCurrent()) {
          emitBlocked(target, tracked ?? null, null, 'stale_restart_requirement');
          return false;
        }
        let current = false;
        try { current = await required.isCurrent(); } catch { /* Leave unavailable currentness unproven. */ }
        if (!capturedOwnerIsCurrent()) {
          emitBlocked(target, tracked ?? null, null, 'stale_restart_requirement');
          return false;
        }
        if (!current) emitBlocked(target, tracked ?? null, null, 'restart_requirement_currentness_unproven');
        return current;
      };
      if (params.restartEnabled === false) {
        if (required) emitBlocked(target, tracked ?? null, null, 'restart_disabled');
        continue;
      }
      if (required) {
        const requirement = required.requirement;
        if (requirement.kind !== 'restart_resume' || requirement.source !== 'failed_adapter_hot_apply'
          || !required.sessionId || !required.runtimeIdentityKey || !requirement.profileId || !requirement.credentialRevision
          || requirement.serviceId !== event.binding.serviceId || requirement.profileId !== event.binding.profileId
          || (requirement.groupId !== null && (requirement.generation === null || !Number.isSafeInteger(requirement.generation)))
          || (event.binding.groupId !== undefined && event.binding.groupId !== requirement.groupId)
          || (event.binding.generation !== undefined && event.binding.generation !== requirement.generation)) {
          emitBlocked(target, tracked ?? null, null, 'restart_requirement_identity_missing');
          continue;
        }
        if (!capturedOwnerIsCurrent()) { emitBlocked(target, tracked ?? null, null, 'stale_restart_requirement'); continue; }
      }
      const descriptor = await observeConnectedServiceAuthStage({
        sessionId: tracked?.happySessionId ?? null,
        bindings: [event.binding],
      }, 'descriptor_lookup', () => params.resolveLifecycleDescriptor(target.agentId));
      if (!(descriptor.serviceIds as readonly string[]).includes(event.binding.serviceId)) {
        if (required) emitBlocked(target, tracked ?? null, null, 'service_unsupported');
        continue;
      }
      const refreshedCredentialApplication = descriptor.refreshedCredentialApplication;
      if (!required && refreshedCredentialApplication.mode !== 'restart_required') continue;
      if (!required && (refreshedCredentialApplication.noRestartRequiredServiceIds ?? []).some((serviceId) => serviceId === event.binding.serviceId)) continue;
      const callbackConditionalService = (
        refreshedCredentialApplication.noRestartRequiredWhenAccessTokenCallbackServiceIds ?? []
      ).some((serviceId) => serviceId === event.binding.serviceId);
      const accessTokenCallbackActive = target.accessTokenRefresh?.mode === 'daemon_callback'
        && target.accessTokenRefresh.serviceIds.includes(event.binding.serviceId);
      if (
        !required && accessTokenCallbackActive
        && callbackConditionalService
      ) {
        continue;
      }
      // Broker-conditional no-restart: skip the restart ONLY when this running target actually holds a
      // broker binding for the service. A non-brokered shape (e.g. a Pi claude-subscription setup-token
      // baked as a raw api_key at spawn) has no broker to hot-apply the reconnected credential, so it
      // falls through to a restart instead of being silently skipped by service id alone.
      const brokerConditionalServiceId = (refreshedCredentialApplication.noRestartRequiredWhenBrokeredServiceIds ?? [])
        .find((serviceId) => serviceId === event.binding.serviceId);
      if (!required && brokerConditionalServiceId) {
        const brokered = refreshedCredentialApplication.isTargetBrokeredForBinding?.({
          serviceId: brokerConditionalServiceId,
          environmentVariables: params.pidToTrackedSession.get(target.pid)?.spawnOptions?.environmentVariables ?? {},
        }) ?? false;
        if (brokered) continue;
      }
      if (!tracked) {
        emitBlocked(target, null, null, 'tracked_session_missing');
        continue;
      }
      if (tracked.startedBy !== 'daemon') {
        emitBlocked(target, tracked, null, 'not_daemon_started');
        continue;
      }
      const processGroupPid = params.resolveProcessGroupPid(tracked);
      if (!tracked.childProcess && processGroupPid === null) {
        emitBlocked(target, tracked, processGroupPid, 'unsupported_restart_signal');
        continue;
      }

      const bindingGroupMetadata = required
        ? { groupId: required.requirement.groupId, generation: required.requirement.generation }
        : resolveConnectedServiceBindingGroupMetadata({ tracked, binding: event.binding });
      // Descriptor lookup can yield; validate the captured request afterward, before reserving.
      if (required && !await requirementIsCurrent()) continue;
      // The canonical queue coalesces pending requests; its executing owner alone reserves the PID.
      // Schedule without retaining refresh custody until a future turn boundary. This call may join
      // another owner's restart, so its own no-signal result grants no reservation cleanup authority.
      let restartRequest: Promise<Readonly<{ signaled: boolean; notSignaledReason?: string }>>;
      try {
        // K5:gated_restart credential refresh inherits canonical deferral and reachability checks.
        restartRequest = params.requestRestartSignal({
          pid: target.pid,
          tracked,
          sessionId: tracked.happySessionId ?? null,
          target: {
            serviceId: event.binding.serviceId,
            profileId: event.binding.profileId,
            groupId: bindingGroupMetadata.groupId ?? '',
            generation: bindingGroupMetadata.generation,
            ...(required?.requirement.credentialRevision == null
              ? {} : { credentialRevision: required.requirement.credentialRevision }),
          },
          processGroupPid,
          delayMs: params.restartSignalDelayMs,
          shouldSignal: required ? requirementIsCurrent : () => params.pidToTrackedSession.get(target.pid) === tracked,
          restartDiagnostic: {
            trigger,
            sessionId: tracked.happySessionId ?? null,
            agentId: target.agentId,
            serviceId: event.binding.serviceId,
            profileId: event.binding.profileId,
            groupId: bindingGroupMetadata.groupId,
            generation: bindingGroupMetadata.generation,
            reason: trigger,
          },
          recordRestartDiagnostic: params.recordRestartDiagnostic,
          nowMs: params.nowMs,
          onSignalFailure: (error) => {
            params.onRestartSignalFailure?.(error, target);
          },
        });
      } catch (error) {
        params.onRestartSignalFailure?.(error, target);
        if (required) emitBlocked(target, tracked, processGroupPid, 'restart_request_failed');
        continue;
      }
      void restartRequest.then(({ signaled, notSignaledReason }) => {
        if (!signaled) {
          if (required) emitBlocked(target, tracked, processGroupPid, 'restart_not_signaled', notSignaledReason);
        }
      }).catch((error) => {
        params.onRestartSignalFailure?.(error, target);
        if (required) emitBlocked(target, tracked, processGroupPid, 'restart_request_failed');
      });
    }
  };
}
