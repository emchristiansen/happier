import { ConnectedServiceBindingsV1Schema, type ConnectedServiceBindingsV1, type ConnectedServiceId } from '@happier-dev/protocol';

/**
 * Provenance of provider-observed evidence: which home the current runner's launch materialized, and
 * whether a per-session decision was launched in that runner. Null when the evidence is not tied to
 * the session's current runner and its launch (an old runner, a shared application).
 */
export type ProviderObservedAccountProvenance = Readonly<{
  launchHome: 'group' | 'member';
  isDecisionLaunchedInRunner: (decisionId: string) => boolean;
}>;

/**
 * Publishes provider-observed account evidence on a group binding. Adoption of the session's pending
 * per-session target (`materializedAssignment`) is proved only by evidence naming that target's
 * member from the runner that applies it (spec A.5 C3′–C4, A.4 Migration, T18/T19):
 * - a member-home target: the current runner was launched with that very decision on the member's
 *   own home; the target becomes the applied `member` (spec A.5 C4–C5);
 * - a group-home conversion target: the current runner was launched on the group's shared home;
 *   per-session ownership ends.
 * Any other evidence (a member-home runner while a conversion is pending, an earlier launch, a
 * delayed report of a replaced runner, a shared application) records `appliedProfileId` only and
 * leaves the pending target and the applied member in place.
 */
export function projectProviderObservedAccountMetadata(
  metadata: Record<string, unknown>,
  observation: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    observedAtMs?: number;
    provenance: ProviderObservedAccountProvenance | null;
  }>,
): Record<string, unknown> {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  if (!parsed.success) return metadata;
  const binding = parsed.data.bindingsByServiceId[observation.serviceId];
  if (binding?.source !== 'connected' || binding.selection !== 'group' || binding.groupId !== observation.groupId) return metadata;
  const pending = binding.materializedAssignment;
  const provenance = observation.provenance;
  const adoptsPending = pending !== undefined
    && pending.profileId === observation.profileId
    && provenance !== null
    && (pending.home === 'group'
      ? provenance.launchHome === 'group'
      : provenance.launchHome === 'member' && provenance.isDecisionLaunchedInRunner(pending.decisionId));
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

/**
 * When a projection proved the session's pending conversion to the group's shared home, the
 * ownership it retires: every per-session decision made at or before that conversion target was
 * materialized. Null when the projection proved no conversion.
 */
export function resolveProvedSharedConversion(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  serviceId: ConnectedServiceId,
): Readonly<{ retiresDecisionsDecidedAtOrBeforeMs: number }> | null {
  const read = (metadata: Record<string, unknown>) => {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
    const binding = parsed.success ? parsed.data.bindingsByServiceId[serviceId] : undefined;
    return binding?.source === 'connected' && binding.selection === 'group' ? binding : null;
  };
  const previous = read(before)?.materializedAssignment;
  const next = read(after);
  return previous?.home === 'group' && next !== null && !next.member && !next.materializedAssignment
    && next.appliedProfileId === previous.profileId
    ? { retiresDecisionsDecidedAtOrBeforeMs: previous.materializedAtMs }
    : null;
}
