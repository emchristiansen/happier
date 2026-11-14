import { ConnectedServiceBindingsV1Schema, type ConnectedServiceId } from '@happier-dev/protocol';

import { readConnectedServiceMaterializationIdentityV1 } from '../../materialize/createConnectedServiceMaterializationIdentity';
import type { PerSessionLiveDecision, PerSessionProvedSharedConversion } from './PerSessionAssignmentRuntime';

type TrackedSessionLike = Readonly<{
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Readonly<Record<string, unknown>> | null;
  spawnOptions?: Readonly<{
    connectedServices?: unknown;
    connectedServiceMaterializationIdentityV1?: unknown;
  }> | null;
}>;

/**
 * Per-session decisions carried by live runners: the applied member and any pending per-session
 * target (a group-home conversion target is not a member decision). The session's own metadata is
 * preferred (it records adoption), falling back to the launch bindings. The reservation subject is the
 * session's materialization identity, the key its decision was made under before a session id existed.
 */
function readSubjectId(session: TrackedSessionLike): string | null {
  const metadata = session.happySessionMetadataFromLocalWebhook ?? null;
  const identity = readConnectedServiceMaterializationIdentityV1(
    metadata?.connectedServiceMaterializationIdentityV1 ?? session.spawnOptions?.connectedServiceMaterializationIdentityV1,
  );
  return identity?.id ?? session.happySessionId ?? null;
}

/** Subjects (materialization identities) of every live runner, whatever its bindings. */
export function collectPerSessionLiveSubjectIds(tracked: Iterable<TrackedSessionLike>): ReadonlySet<string> {
  const subjects = new Set<string>();
  for (const session of tracked) {
    const subjectId = readSubjectId(session);
    if (subjectId) subjects.add(subjectId);
  }
  return subjects;
}

export function collectPerSessionLiveDecisions(tracked: Iterable<TrackedSessionLike>): PerSessionLiveDecision[] {
  const decisions = new Map<string, PerSessionLiveDecision>();
  for (const session of tracked) {
    const metadata = session.happySessionMetadataFromLocalWebhook ?? null;
    const subjectId = readSubjectId(session);
    if (!subjectId) continue;
    const fromMetadata = ConnectedServiceBindingsV1Schema.safeParse(metadata?.connectedServices);
    const parsed = fromMetadata.success ? fromMetadata : ConnectedServiceBindingsV1Schema.safeParse(session.spawnOptions?.connectedServices);
    if (!parsed.success) continue;
    for (const [serviceId, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
      if (!binding || binding.source !== 'connected' || binding.selection !== 'group') continue;
      // Both decisions a runner carries are live: the applied member it still serves on and the
      // pending target it is moving to. The applied one is retired only by adoption of the target.
      const pending = binding.materializedAssignment;
      const applied = binding.member;
      const carried = [
        ...(applied ? [{ assignment: applied, isApplied: true }] : []),
        ...(pending && pending.home !== 'group' ? [{ assignment: pending, isApplied: false }] : []),
      ];
      for (const { assignment, isApplied } of carried) {
        decisions.set(assignment.decisionId, {
          serviceId: serviceId as ConnectedServiceId,
          groupId: binding.groupId,
          decisionId: assignment.decisionId,
          profileId: assignment.profileId,
          subjectId,
          applied: isApplied,
          reason: assignment.reason,
          ...(assignment.fromProfileId ? { fromProfileId: assignment.fromProfileId } : {}),
          ...(assignment.temperature === undefined ? {} : { temperature: assignment.temperature }),
          ...(assignment.offsetPercent === undefined ? {} : { offsetPercent: assignment.offsetPercent }),
          ...(assignment.probability === undefined ? {} : { probability: assignment.probability }),
        });
      }
    }
  }
  return [...decisions.values()];
}

function readGroupBindings(value: unknown) {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const groups = new Map<string, Extract<(typeof parsed.data.bindingsByServiceId)[string], { selection: 'group' }>>();
  for (const [serviceId, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
    if (binding?.source === 'connected' && binding.selection === 'group') groups.set(serviceId, binding);
  }
  return groups;
}

/**
 * Live runners whose committed (provider-observed) metadata proves conversion to the group's shared
 * home (spec A.4 Migration), read durably so a settlement interrupted after the metadata commit is
 * completed on a later pass. The proof needs all of:
 * - the session's own metadata binding for the group has no per-session field and records the
 *   provider-observed `appliedProfileId`; the projection removes those fields only on proved
 *   conversion, and spawn under a rolled-back policy keeps them (pending `home:'group'`);
 * - the runner was launched for the group home: its launch binding's pending target is
 *   `home:'group'` on that same observed account, or it carries no per-session field at all.
 * A runner launched for a per-session member, launch bindings alone, or a wrong observed account
 * prove nothing.
 */
export function collectPerSessionProvedSharedConversions(tracked: Iterable<TrackedSessionLike>): PerSessionProvedSharedConversion[] {
  const conversions: PerSessionProvedSharedConversion[] = [];
  for (const session of tracked) {
    const subjectId = readSubjectId(session);
    const committed = readGroupBindings(session.happySessionMetadataFromLocalWebhook?.connectedServices);
    if (!subjectId || !committed) continue;
    const launched = readGroupBindings(session.spawnOptions?.connectedServices);
    for (const [serviceId, binding] of committed) {
      if (binding.member || binding.materializedAssignment || !binding.appliedProfileId) continue;
      const launch = launched?.get(serviceId);
      if (!launch || launch.groupId !== binding.groupId) continue;
      const launchedForGroupHome = launch.materializedAssignment
        ? launch.materializedAssignment.home === 'group' && launch.materializedAssignment.profileId === binding.appliedProfileId
        : !launch.member;
      if (!launchedForGroupHome) continue;
      conversions.push({ subjectId, serviceId: serviceId as ConnectedServiceId, groupId: binding.groupId });
    }
  }
  return conversions;
}
