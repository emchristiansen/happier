import type { ConnectedServiceId } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import type { ConnectedServiceRuntimeRegistry, ConnectedServiceRuntimeTarget } from '../runtimeRegistry/registry';
import {
  resolveConnectedServiceGroupMemberProviderAccountResolution,
  type ConnectedServiceGroupMemberProviderAccountIdentity,
  type ConnectedServiceGroupMemberProviderAccountResolution,
} from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

/**
 * What the application owner did with a resolved observation. Only `adopted` means the observation
 * passed the registry/native currentness checks; the others are retained as raw evidence.
 */
export type ProviderObservedSessionAccountAdoption =
  | 'adopted'
  | 'not_unique_member'
  | 'rejected_not_current'
  | 'rejected_by_registry';

export async function reconcileProviderObservedSessionAccount(input: Readonly<{
  runtimeRegistry: ConnectedServiceRuntimeRegistry;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  providerOrganizationId: string | null;
  observedAtMs: number;
  sourceSessionId: string;
  getCurrentProviderSessionId: () => string | null;
  getGroup: () => Promise<Readonly<{
    generation: number;
    members: ReadonlyArray<Readonly<{ profileId: string }>>;
  }> | null>;
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
  /**
   * Receives every resolved observation once, including ambiguous and unproven ones, together with
   * its adoption disposition decided AFTER the currentness recheck.
   */
  onResolution?: (
    resolution: ConnectedServiceGroupMemberProviderAccountResolution,
    adoption: ProviderObservedSessionAccountAdoption,
  ) => Promise<void> | void;
}>): Promise<Readonly<{ target: ConnectedServiceRuntimeTarget; generationBehind: boolean }> | null> {
  if (input.getCurrentProviderSessionId() !== input.sourceSessionId) return null;
  const before = input.runtimeRegistry.getBySessionId(input.sessionId);
  const binding = before?.activeBindings.find((candidate) => (
    candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
  ));
  if (!before || !binding) return null;
  const group = await input.getGroup();
  if (!group) return null;
  const resolution = await resolveConnectedServiceGroupMemberProviderAccountResolution({
    providerOrganizationId: input.providerOrganizationId,
    members: group.members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  const profileId = resolution.kind === 'unique_member' ? resolution.profileId : null;
  if (!profileId) {
    await input.onResolution?.(resolution, 'not_unique_member');
    logger.warn('[ConnectedServices] Provider session account observation is unproven', {
      sessionId: input.sessionId, serviceId: input.serviceId, groupId: input.groupId,
      errorCode: 'provider_session_account_observation_unproven',
    });
    return null;
  }
  // A replacement/application during identity resolution owns the newer state. The provider
  // timestamp is checked by the registry too, covering reordered observations of one registration.
  if (input.runtimeRegistry.getBySessionId(input.sessionId) !== before
    || input.getCurrentProviderSessionId() !== input.sourceSessionId) {
    await input.onResolution?.(resolution, 'rejected_not_current');
    return null;
  }
  const target = input.runtimeRegistry.adoptProviderObservedGroupAccountForSession({
    sessionId: input.sessionId, serviceId: input.serviceId, groupId: input.groupId,
    profileId, observedAtMs: input.observedAtMs,
  });
  await input.onResolution?.(resolution, target ? 'adopted' : 'rejected_by_registry');
  if (!target) return null;
  return { target, generationBehind: binding.generation !== null && binding.generation < group.generation };
}

/** Keep account publication and generation catch-up on the same observed-account path. */
export async function handleProviderObservedSessionAccount(input: Parameters<typeof reconcileProviderObservedSessionAccount>[0] & Readonly<{
  publishAccount: (target: ConnectedServiceRuntimeTarget) => Promise<void>;
  reconcileGeneration: (target: ConnectedServiceRuntimeTarget) => Promise<void>;
}>): Promise<void> {
  const observed = await reconcileProviderObservedSessionAccount(input);
  if (!observed) return;
  if (observed.generationBehind) await input.reconcileGeneration(observed.target);
  await input.publishAccount(observed.target);
}
