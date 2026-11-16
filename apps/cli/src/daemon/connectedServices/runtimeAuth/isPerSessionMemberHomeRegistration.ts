import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type { ConnectedServiceRuntimeBindingIdentity } from '../runtimeRegistry/target';

/**
 * Whether a registered runtime binding is a per_session_softmax member home (FAILOVER-SRC-01): the
 * runner was launched with the binding's own profile selection inside the bound group (so the
 * registry records the group without a group generation), and the session binding carries
 * per-session ownership (an applied member or a materialized target). Only then is the
 * (group, profile, credential revision, null generation) form an exact runtime source.
 */
export function isPerSessionMemberHomeRegistration(input: Readonly<{
  binding: ConnectedServiceRuntimeBindingIdentity;
  selections: ReadonlyArray<ConnectedServiceChildSelection>;
  bindingsRaw: unknown;
}>): boolean {
  const { binding } = input;
  if (!binding.groupId || binding.generation !== null) return false;
  const selection = input.selections.find((candidate) => candidate.serviceId === binding.serviceId);
  if (selection?.kind !== 'profile' || selection.profileId !== binding.profileId) return false;
  const bindingsByServiceId = typeof input.bindingsRaw === 'object' && input.bindingsRaw !== null
    ? (input.bindingsRaw as { bindingsByServiceId?: unknown }).bindingsByServiceId
    : undefined;
  const raw = typeof bindingsByServiceId === 'object' && bindingsByServiceId !== null
    ? (bindingsByServiceId as Record<string, unknown>)[binding.serviceId]
    : undefined;
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as { selection?: unknown; groupId?: unknown; member?: unknown; materializedAssignment?: unknown };
  return record.selection === 'group' && record.groupId === binding.groupId
    && Boolean(record.member || record.materializedAssignment);
}
