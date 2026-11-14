import { ConnectedServiceBindingsV1Schema, type ConnectedServiceBindingsV1, type ConnectedServiceId } from '@happier-dev/protocol';

/**
 * Publishes provider-observed account evidence on a group binding. When the observed member is the
 * session's own pending per-session target (`materializedAssignment`), adoption is proved: the
 * target becomes the applied `member` (spec A.5 C4–C5); a proved conversion to the group home ends
 * per-session ownership. A different observed member leaves the pending target in place.
 */
export function projectProviderObservedAccountMetadata(
  metadata: Record<string, unknown>,
  observation: Readonly<{ serviceId: ConnectedServiceId; groupId: string; profileId: string; observedAtMs?: number }>,
): Record<string, unknown> {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  if (!parsed.success) return metadata;
  const binding = parsed.data.bindingsByServiceId[observation.serviceId];
  if (binding?.source !== 'connected' || binding.selection !== 'group' || binding.groupId !== observation.groupId) return metadata;
  const pending = binding.materializedAssignment;
  const adoptsPending = pending !== undefined && pending.profileId === observation.profileId;
  if (binding.appliedProfileId === observation.profileId && !adoptsPending) return metadata;
  const { materializedAssignment: _adopted, ...rest } = binding;
  if (adoptsPending && pending.home === 'group') {
    // Proved conversion to the group home (spec A.4 Migration): per-session ownership ends here.
    const { member: _member, initialProfileId: _initial, ...shared } = rest;
    return withBinding(metadata, parsed.data, observation.serviceId, { ...shared, appliedProfileId: observation.profileId });
  }
  const nextBinding = adoptsPending
    ? {
      ...rest,
      appliedProfileId: observation.profileId,
      member: {
        assignment: 'per_session' as const,
        profileId: pending.profileId,
        decisionId: pending.decisionId,
        reason: pending.reason,
        ...(pending.fromProfileId ? { fromProfileId: pending.fromProfileId } : {}),
        appliedAtMs: observation.observedAtMs ?? Date.now(),
        ...(pending.temperature === undefined ? {} : { temperature: pending.temperature }),
        ...(pending.offsetPercent === undefined ? {} : { offsetPercent: pending.offsetPercent }),
        ...(pending.probability === undefined ? {} : { probability: pending.probability }),
      },
    }
    : { ...binding, appliedProfileId: observation.profileId };
  return withBinding(metadata, parsed.data, observation.serviceId, nextBinding);
}

function withBinding(
  metadata: Record<string, unknown>,
  bindings: ConnectedServiceBindingsV1,
  serviceId: ConnectedServiceId,
  nextBinding: unknown,
): Record<string, unknown> {
  return {
    ...metadata,
    connectedServices: {
      ...bindings,
      bindingsByServiceId: {
        ...bindings.bindingsByServiceId,
        [serviceId]: nextBinding,
      },
    },
  };
}

/** The pending per-session decision a projection adopted, if any (for reservation/ledger settlement). */
export function resolveAdoptedPerSessionDecisionId(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  serviceId: ConnectedServiceId,
): string | null {
  const read = (metadata: Record<string, unknown>) => {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
    const binding = parsed.success ? parsed.data.bindingsByServiceId[serviceId] : undefined;
    return binding?.source === 'connected' && binding.selection === 'group' ? binding : null;
  };
  const previous = read(before)?.materializedAssignment;
  const next = read(after);
  return previous && !next?.materializedAssignment && next?.member?.decisionId === previous.decisionId
    ? previous.decisionId
    : null;
}

/** True when a projection proved the session's pending conversion to the group's shared home. */
export function resolveProvedSharedConversion(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  serviceId: ConnectedServiceId,
): boolean {
  const read = (metadata: Record<string, unknown>) => {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
    const binding = parsed.success ? parsed.data.bindingsByServiceId[serviceId] : undefined;
    return binding?.source === 'connected' && binding.selection === 'group' ? binding : null;
  };
  const previous = read(before)?.materializedAssignment;
  const next = read(after);
  return previous?.home === 'group' && next !== null && !next.member && !next.materializedAssignment
    && next.appliedProfileId === previous.profileId;
}

/**
 * True when committed metadata already records a proved conversion to the group home for the observed
 * account: the group binding carries no per-session field and its provider-observed account is the
 * observed one. The projection removes those fields only on proved conversion (spec A.4 Migration),
 * so a repeated observation after a crash between the metadata commit and settlement re-proves it.
 * A session that never held per-session decisions matches too; settling it releases nothing.
 */
export function resolveCommittedSharedConversion(
  metadata: Record<string, unknown>,
  observation: Readonly<{ serviceId: ConnectedServiceId; groupId: string; profileId: string }>,
): boolean {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  const binding = parsed.success ? parsed.data.bindingsByServiceId[observation.serviceId] : undefined;
  return binding?.source === 'connected' && binding.selection === 'group' && binding.groupId === observation.groupId
    && !binding.member && !binding.materializedAssignment && binding.appliedProfileId === observation.profileId;
}
