import {
  AccountProfileSchema,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceProjectedAuthGroup = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
}>;

export type ConnectedServiceProjectedCredentialBoundary =
  | Readonly<{ status: 'absent' }>
  | Readonly<{
      status: 'present';
      revisionSemantics: 'revisioned';
      credentialRevision: ConnectedServiceCredentialRevisionV1;
    }>
  | Readonly<{
      status: 'present';
      revisionSemantics: 'legacy_unfenced';
      credentialRevision: null;
    }>;

export type ConnectedServiceProjectedCredential = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  boundary: ConnectedServiceProjectedCredentialBoundary;
}>;

/** Every enabled member of one group, as projected by the server (disabled members are omitted). */
export type ConnectedServiceProjectedAuthGroupMembership = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  memberProfileIds: readonly string[];
}>;

export type ConnectedServiceProjectedGroupMember = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
}>;

export type ConnectedServiceProjectionSnapshot = Readonly<{
  groups: readonly ConnectedServiceProjectedAuthGroup[];
  groupMemberships: readonly ConnectedServiceProjectedAuthGroupMembership[];
  credentials: readonly ConnectedServiceProjectedCredential[];
  /**
   * A member is eligible to keep serving per-session-owned sessions while it is an enabled member
   * of a projected group and its credential is present.
   */
  isGroupMemberEligible: (serviceId: ConnectedServiceId, groupId: string, profileId: string) => boolean;
  resolveCredentialBoundary: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialBoundary;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
}>;

export type ConnectedServiceProjectionDelta = Readonly<{
  changedGroupScopes: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>>;
  changedCredentialBoundaries: readonly ConnectedServiceProjectedCredential[];
  /** Members eligible in the previous projection and no longer eligible now (disabled, removed, credential gone). */
  revokedGroupMembers: readonly ConnectedServiceProjectedGroupMember[];
}>;

function credentialScopeKey(serviceId: ConnectedServiceId, profileId: string): string {
  return `${serviceId}\0${profileId}`;
}

function groupScopeKey(serviceId: ConnectedServiceId, groupId: string): string {
  return `${serviceId}\0${groupId}`;
}

function groupMemberKey(member: ConnectedServiceProjectedGroupMember): string {
  return `${member.serviceId}\0${member.groupId}\0${member.profileId}`;
}

function listEligibleGroupMembers(snapshot: ConnectedServiceProjectionSnapshot): ConnectedServiceProjectedGroupMember[] {
  return snapshot.groupMemberships.flatMap((membership) => membership.memberProfileIds
    .filter((profileId) => snapshot.isGroupMemberEligible(membership.serviceId, membership.groupId, profileId))
    .map((profileId) => ({ serviceId: membership.serviceId, groupId: membership.groupId, profileId })));
}

export function diffConnectedServiceProjectionSnapshots(
  previous: ConnectedServiceProjectionSnapshot | null,
  current: ConnectedServiceProjectionSnapshot,
): ConnectedServiceProjectionDelta {
  if (!previous) return { changedGroupScopes: [], changedCredentialBoundaries: [], revokedGroupMembers: [] };
  const previousGroups = new Map(previous.groups.map((group) => [
    groupScopeKey(group.serviceId, group.groupId),
    group,
  ] as const));
  const currentGroups = new Map(current.groups.map((group) => [
    groupScopeKey(group.serviceId, group.groupId),
    group,
  ] as const));
  const changedGroupScopes = [...new Set([...previousGroups.keys(), ...currentGroups.keys()])]
    .filter((key) => {
      const before = previousGroups.get(key);
      const after = currentGroups.get(key);
      if (!before || !after) return true;
      if (
        before.activeProfileId !== after.activeProfileId
        || before.generation !== after.generation
      ) return true;
      if (!after.activeProfileId) return false;
      return previous.resolveCredentialRevision(after.serviceId, after.activeProfileId)
        !== current.resolveCredentialRevision(after.serviceId, after.activeProfileId);
    })
    .map((key) => {
      const group = currentGroups.get(key) ?? previousGroups.get(key)!;
      return { serviceId: group.serviceId, groupId: group.groupId };
    })
    .sort((left, right) => groupScopeKey(left.serviceId, left.groupId)
      .localeCompare(groupScopeKey(right.serviceId, right.groupId)));
  const previousCredentials = new Map(previous.credentials.map((entry) => [
    credentialScopeKey(entry.serviceId, entry.profileId),
    entry,
  ] as const));
  const currentCredentials = new Map(current.credentials.map((entry) => [
    credentialScopeKey(entry.serviceId, entry.profileId),
    entry,
  ] as const));
  const changedCredentialBoundaries = [...new Set([
    ...previousCredentials.keys(),
    ...currentCredentials.keys(),
  ])]
    .filter((key) => {
      const before = previousCredentials.get(key)?.boundary ?? { status: 'absent' };
      const after = currentCredentials.get(key)?.boundary ?? { status: 'absent' };
      if (after.status === 'absent') return before.status === 'present';
      if (after.revisionSemantics === 'legacy_unfenced') return false;
      return before.status !== 'present'
        || before.revisionSemantics !== 'revisioned'
        || before.credentialRevision !== after.credentialRevision;
    })
    .map((key) => {
      const entry = currentCredentials.get(key) ?? previousCredentials.get(key)!;
      return {
        serviceId: entry.serviceId,
        profileId: entry.profileId,
        boundary: currentCredentials.get(key)?.boundary ?? { status: 'absent' },
      };
    })
    .sort((left, right) => credentialScopeKey(left.serviceId, left.profileId)
      .localeCompare(credentialScopeKey(right.serviceId, right.profileId)));
  const revokedGroupMembers = listEligibleGroupMembers(previous)
    .filter((member) => !current.isGroupMemberEligible(member.serviceId, member.groupId, member.profileId))
    .sort((left, right) => groupMemberKey(left).localeCompare(groupMemberKey(right)));
  return { changedGroupScopes, changedCredentialBoundaries, revokedGroupMembers };
}

export function parseConnectedServiceProjectionSnapshot(input: Readonly<{
  connectedServicesV2: unknown;
  connectedServiceCredentialRevisionsV1: unknown;
}>): ConnectedServiceProjectionSnapshot {
  const profile = AccountProfileSchema.parse({
    id: 'connected-service-projection',
    connectedServicesV2: input.connectedServicesV2,
    connectedServiceCredentialRevisionsV1: input.connectedServiceCredentialRevisionsV1,
  });
  const groups = profile.connectedServicesV2.flatMap((service) => service.groups.map((group) => ({
    serviceId: service.serviceId,
    groupId: group.groupId,
    activeProfileId: group.activeProfileId,
    generation: group.generation,
  })));
  const groupMemberships = profile.connectedServicesV2.flatMap((service) => service.groups.map((group) => ({
    serviceId: service.serviceId,
    groupId: group.groupId,
    memberProfileIds: [...new Set(group.memberProfileIds)],
  })));
  const memberKeys = new Set(groupMemberships.flatMap((membership) => membership.memberProfileIds.map((profileId) => (
    groupMemberKey({ serviceId: membership.serviceId, groupId: membership.groupId, profileId })
  ))));
  const credentialsByScope = new Map<string, ConnectedServiceProjectedCredential>();
  for (const service of profile.connectedServicesV2) {
    for (const credential of service.profiles) {
      credentialsByScope.set(credentialScopeKey(service.serviceId, credential.profileId), {
        serviceId: service.serviceId,
        profileId: credential.profileId,
        boundary: {
          status: 'present',
          revisionSemantics: 'legacy_unfenced',
          credentialRevision: null,
        },
      });
    }
  }
  for (const credential of profile.connectedServiceCredentialRevisionsV1) {
    credentialsByScope.set(credentialScopeKey(credential.serviceId, credential.profileId), {
      serviceId: credential.serviceId,
      profileId: credential.profileId,
      boundary: {
        status: 'present',
        revisionSemantics: 'revisioned',
        credentialRevision: credential.credentialRevision,
      },
    });
  }
  const credentials = [...credentialsByScope.values()].sort((left, right) => (
    credentialScopeKey(left.serviceId, left.profileId)
      .localeCompare(credentialScopeKey(right.serviceId, right.profileId))
  ));
  const resolveCredentialBoundary = (
    serviceId: ConnectedServiceId,
    profileId: string,
  ): ConnectedServiceProjectedCredentialBoundary => (
    credentialsByScope.get(credentialScopeKey(serviceId, profileId))?.boundary
      ?? { status: 'absent' }
  );
  return {
    groups,
    groupMemberships,
    credentials,
    isGroupMemberEligible: (serviceId, groupId, profileId) => (
      memberKeys.has(groupMemberKey({ serviceId, groupId, profileId }))
      && resolveCredentialBoundary(serviceId, profileId).status === 'present'
    ),
    resolveCredentialBoundary,
    resolveCredentialRevision: (serviceId, profileId) => {
      const boundary = resolveCredentialBoundary(serviceId, profileId);
      return boundary.status === 'present' && boundary.revisionSemantics === 'revisioned'
        ? boundary.credentialRevision
        : null;
    },
  };
}
