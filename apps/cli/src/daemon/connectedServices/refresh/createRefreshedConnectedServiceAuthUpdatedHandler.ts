import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceSessionAuthSwitchReason } from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
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

/**
 * Applies a refreshed or reconnected credential to every running session bound to it, then hands
 * the event to the descriptor-driven restart handler.
 *
 * A session whose runtime cannot hot-apply the credential (`hot_apply_restart_required`) is left
 * to that restart handler instead of failing the whole event. Throwing here escaped the account
 * changes sync, so its cursor never saved and the daemon retried the same changes every ~2 s for
 * as long as such a session ran. What happens to the skipped session depends on its agent's
 * lifecycle descriptor, exactly as for any other refresh:
 * - Claude on `claude-subscription` needs no restart by design: its runners re-read the refreshed
 *   `.credentials.json` the daemon writes, and the descriptor exempts that service.
 * - Agents whose descriptor requires a restart get the handler's gated restart at a turn boundary.
 * - Codex (mode `hot_apply`), and OpenCode and Pi for the services their descriptors exempt, are
 *   NOT restarted: such a session keeps its previous credential. That was already so when this
 *   threw; it is now reported through `onRestartRequired` instead of looping.
 * Every other failure keeps its previous behaviour and still throws.
 */
export function createRefreshedConnectedServiceAuthUpdatedHandler(params: Readonly<{
  applyRefreshedAuth: RefreshedConnectedServiceAuthApplication;
  restartAfterAuthUpdated: (event: AuthUpdatedEvent) => Promise<void>;
  onRestartRequired: (diagnostic: RefreshedAuthRestartRequiredDiagnostic) => void;
}>): OnAuthUpdated {
  return async (event) => {
    if (event.mutation === 'deleted') {
      await params.restartAfterAuthUpdated(event);
      return { appliedRuntimeIdentityKeys: new Set<string>() };
    }

    const appliedSessionIds = new Set<string>();
    const appliedRuntimeIdentityKeys = new Set<string>();
    for (const target of event.affectedTargets) {
      const sessionId = String(target.sessionId ?? '').trim();
      if (!sessionId || appliedSessionIds.has(sessionId)) continue;
      const selection = target.selectionsByServiceId.get(event.binding.serviceId);
      if (!selection) continue;
      const activeProfileId = selection.kind === 'profile'
        ? selection.profileId
        : selection.activeProfileId;
      if (activeProfileId !== event.binding.profileId) continue;

      const result = await params.applyRefreshedAuth({
        sessionId,
        serviceId: event.binding.serviceId,
        groupId: selection.kind === 'group' ? selection.groupId : null,
        activeProfileId,
        generation: selection.kind === 'group' ? selection.generation : null,
        credentialRevision: event.credentialRevision,
        reason: event.trigger,
        switchReason: 'automatic_runtime_failure',
        fromProfileId: activeProfileId,
      });
      if (!result.ok) {
        if (result.errorCode === 'restart_disallowed_by_execution_policy') continue;
        if (result.errorCode === 'hot_apply_restart_required') {
          params.onRestartRequired({
            sessionId,
            pid: target.pid,
            agentId: target.agentId,
            serviceId: event.binding.serviceId,
            profileId: event.binding.profileId,
            errorCode: 'hot_apply_restart_required',
          });
          continue;
        }
        throw new Error(`connected_service_refreshed_auth_application_failed:${result.errorCode ?? 'unknown'}`);
      }
      if (result.action !== 'hot_applied') continue;
      appliedSessionIds.add(sessionId);
      for (const affectedTarget of event.affectedTargets) {
        if (
          affectedTarget.sessionId === sessionId
          && affectedTarget.pid === target.pid
        ) {
          appliedRuntimeIdentityKeys.add(affectedTarget.runtimeIdentityKey);
        }
      }
    }

    await params.restartAfterAuthUpdated(event);
    return { appliedRuntimeIdentityKeys };
  };
}
