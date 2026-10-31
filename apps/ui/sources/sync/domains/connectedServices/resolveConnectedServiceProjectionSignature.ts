export function resolveConnectedServiceProjectionSignature(service: Readonly<{
    profiles?: ReadonlyArray<Readonly<{
        profileId?: string;
        status?: string;
        kind?: string | null;
        providerEmail?: string | null;
    }>>;
    groups?: ReadonlyArray<Readonly<{
        groupId?: string;
        displayName?: string | null;
        activeProfileId?: string | null;
        generation?: number;
        memberProfileIds?: ReadonlyArray<string>;
    }>>;
}> | null): string {
    if (!service) return '';
    return JSON.stringify({
        groups: (service.groups ?? []).map((group) => ({
            activeProfileId: group.activeProfileId ?? null,
            displayName: group.displayName ?? '',
            generation: group.generation ?? 0,
            groupId: group.groupId ?? '',
            memberProfileIds: [...(group.memberProfileIds ?? [])],
        })),
        profiles: (service.profiles ?? []).map((profile) => ({
            kind: profile.kind ?? null,
            profileId: profile.profileId ?? '',
            providerEmail: profile.providerEmail ?? null,
            status: profile.status ?? '',
        })),
    });
}
