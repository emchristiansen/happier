import { ConnectedServiceBindingsV1Schema, type ConnectedServiceId } from '@happier-dev/protocol';

import { findConnectedServiceChildSelection } from '../../connectedServiceChildEnvironment';
import { readConnectedServiceMaterializationIdentityV1 } from '../../materialize/createConnectedServiceMaterializationIdentity';
import type { PerSessionSessionBinding } from './PerSessionFailoverCoordinator';

type TrackedSessionLike = Readonly<{
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
 * A not-yet-assigned shared session (migration) serves on the member its launch selected.
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
  return {
    subjectId,
    ...(binding.initialProfileId ? { initialProfileId: binding.initialProfileId } : {}),
    ...(binding.member ? { member: binding.member } : {}),
    ...(binding.materializedAssignment ? { materializedAssignment: binding.materializedAssignment } : {}),
    currentProfileId: binding.member?.profileId
      ?? binding.materializedAssignment?.profileId
      ?? binding.appliedProfileId
      ?? launchedProfileId
      ?? null,
  };
}
