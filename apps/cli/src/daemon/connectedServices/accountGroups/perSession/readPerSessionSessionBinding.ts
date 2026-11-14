import { ConnectedServiceBindingsV1Schema, type ConnectedServiceId } from '@happier-dev/protocol';

import { findConnectedServiceChildSelection } from '../../connectedServiceChildEnvironment';
import { readConnectedServiceMaterializationIdentityV1 } from '../../materialize/createConnectedServiceMaterializationIdentity';
import type { PerSessionSessionBinding } from './PerSessionFailoverCoordinator';
import { readTrackedLauncherIdentity } from './readTrackedLauncherIdentity';

type TrackedSessionLike = Readonly<{
  pid?: number;
  sessionRunnerPid?: number;
  processInstanceFingerprint?: string;
  launchedConnectedServices?: unknown;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Readonly<Record<string, unknown>> | null;
  spawnOptions?: Readonly<{
    connectedServices?: unknown;
    connectedServiceMaterializationIdentityV1?: unknown;
    environmentVariables?: Record<string, string>;
  }> | null;
}>;

/**
 * A live session's group binding as per-session recovery sees it: its own applied member and
 * pending target, the subject its decisions are keyed by, and the account it currently serves on.
 * Serving identity is proved only by an applied `member`; a pending-only target (first spawn not yet
 * adopted) serves on no proved account (spec A.4, T19). A not-yet-assigned shared session
 * (migration) serves on the member its launch selected.
 */
export function readPerSessionSessionBinding(
  tracked: TrackedSessionLike,
  serviceId: ConnectedServiceId,
  groupId: string,
): PerSessionSessionBinding | null {
  const metadata = tracked.happySessionMetadataFromLocalWebhook ?? null;
  const identity = readConnectedServiceMaterializationIdentityV1(
    metadata?.connectedServiceMaterializationIdentityV1 ?? tracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
  );
  const subjectId = identity?.id ?? tracked.happySessionId ?? null;
  if (!subjectId) return null;
  const fromMetadata = ConnectedServiceBindingsV1Schema.safeParse(metadata?.connectedServices);
  const parsed = fromMetadata.success
    ? fromMetadata
    : ConnectedServiceBindingsV1Schema.safeParse(tracked.spawnOptions?.connectedServices);
  if (!parsed.success) return null;
  const binding = parsed.data.bindingsByServiceId[serviceId];
  if (!binding || binding.source !== 'connected' || binding.selection !== 'group' || binding.groupId !== groupId) return null;
  const launched = findConnectedServiceChildSelection(tracked.spawnOptions?.environmentVariables ?? {}, serviceId);
  const launchedProfileId = launched
    ? (launched.kind === 'group' ? launched.activeProfileId : launched.profileId)
    : null;
  const runner = readTrackedLauncherIdentity(tracked);
  return {
    subjectId,
    ...(binding.initialProfileId ? { initialProfileId: binding.initialProfileId } : {}),
    ...(binding.member ? { member: binding.member } : {}),
    ...(binding.materializedAssignment ? { materializedAssignment: binding.materializedAssignment } : {}),
    currentProfileId: binding.member
      ? binding.member.profileId
      : binding.materializedAssignment
        ? null
        : binding.appliedProfileId ?? launchedProfileId ?? null,
    ...(runner ? { runner } : {}),
    ...readRunnerLaunchedDecisionIds(tracked.launchedConnectedServices, serviceId, groupId),
  };
}

/**
 * The decisions of this group binding the current runner was actually launched with, from the
 * bindings its spawn site recorded: the effect owner's readback, never the respawn descriptor or
 * metadata (HPI-21/31/32). Absent when the launch was not observed (a runner reattached from disk).
 */
function readRunnerLaunchedDecisionIds(
  launched: unknown,
  serviceId: ConnectedServiceId,
  groupId: string,
): Readonly<{ runnerLaunchedDecisionIds?: ReadonlyArray<string> }> {
  if (launched === undefined) return {};
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(launched);
  const binding = parsed.success ? parsed.data.bindingsByServiceId[serviceId] : undefined;
  if (!binding || binding.source !== 'connected' || binding.selection !== 'group' || binding.groupId !== groupId) {
    return { runnerLaunchedDecisionIds: [] };
  }
  return {
    runnerLaunchedDecisionIds: [binding.member?.decisionId, binding.materializedAssignment?.decisionId]
      .filter((id): id is string => typeof id === 'string'),
  };
}
