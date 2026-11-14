export type ConnectedServiceGroupMemberProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerOrganizationId?: string | null;
}>;

type ConnectedServiceGroupMemberIdentityCandidate = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export type ConnectedServiceGroupMemberProviderAccountResolution =
  | Readonly<{ kind: 'unique_member'; profileId: string }>
  | Readonly<{ kind: 'ambiguous'; matchingProfileIds: ReadonlyArray<string> }>
  | Readonly<{ kind: 'unproven'; reason: 'no_provider_identity' | 'member_identity_unreadable' | 'no_matching_member' }>;

export async function resolveConnectedServiceGroupMemberByProviderAccountId(input: Readonly<{
  providerAccountId?: string | null;
  providerOrganizationId?: string | null;
  members: readonly ConnectedServiceGroupMemberIdentityCandidate[];
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<string | null> {
  const resolution = await resolveConnectedServiceGroupMemberProviderAccountResolution(input);
  return resolution.kind === 'unique_member' ? resolution.profileId : null;
}

/**
 * The same rule, with the reason a member was not identified kept distinct: an organization shared
 * by several members is ambiguous, and an unreadable member identity leaves organization-only
 * evidence unproven. Neither is ever reported as a member.
 */
export async function resolveConnectedServiceGroupMemberProviderAccountResolution(input: Readonly<{
  providerAccountId?: string | null;
  providerOrganizationId?: string | null;
  members: readonly ConnectedServiceGroupMemberIdentityCandidate[];
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<ConnectedServiceGroupMemberProviderAccountResolution> {
  const providerAccountId = readNonEmptyString(input.providerAccountId);
  const providerOrganizationId = readNonEmptyString(input.providerOrganizationId);
  // Native transcript evidence may attest only an organization. It identifies a member only
  // when that organization is unique across the pool (including disabled members).
  if (!providerAccountId && !providerOrganizationId) return { kind: 'unproven', reason: 'no_provider_identity' };
  const matches: string[] = [];
  for (const member of input.members) {
    const profileId = readNonEmptyString(member.profileId);
    if (!profileId) continue;
    try {
      const identity = await input.resolveProviderAccountIdentity(profileId);
      if (!identity && !providerAccountId) return { kind: 'unproven', reason: 'member_identity_unreadable' };
      if (identity && (!providerAccountId || readNonEmptyString(identity.providerAccountId) === providerAccountId)) {
        // An account-only observation cannot attest an organization-bearing quota context.
        if (readNonEmptyString(identity?.providerOrganizationId) !== providerOrganizationId) continue;
        matches.push(profileId);
      }
    } catch {
      if (!providerAccountId) return { kind: 'unproven', reason: 'member_identity_unreadable' };
      // An unreadable member contributes no positive match. Readable duplicate identities still
      // remain ambiguous for account-qualified evidence. Organization-only evidence cannot
      // establish uniqueness while another member's identity is unknown.
    }
  }
  if (matches.length === 1 && matches[0]) return { kind: 'unique_member', profileId: matches[0] };
  return matches.length === 0
    ? { kind: 'unproven', reason: 'no_matching_member' }
    : { kind: 'ambiguous', matchingProfileIds: matches };
}
