import { ConnectedServiceBindingsV1Schema, type ConnectedServiceId } from '@happier-dev/protocol';

import { readConnectedServiceMaterializationIdentityV1 } from '../../materialize/createConnectedServiceMaterializationIdentity';
import type { PerSessionLiveDecision } from './PerSessionAssignmentRuntime';

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
