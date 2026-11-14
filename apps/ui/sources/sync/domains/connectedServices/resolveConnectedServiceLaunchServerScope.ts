import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

/**
 * Which server's connected-service data a launch reads: the active (Home) server, or another launch
 * target, read with that server's own profile URL and credentials. A target is never answered from
 * the active server's data or bearer.
 */
export type ConnectedServiceLaunchServerScope =
    | Readonly<{ kind: 'active' }>
    | Readonly<{ kind: 'target'; serverId: string; serverUrl: string; credentials: AuthCredentials }>;

/** True when `targetServerId` names no server or the active one. */
export function isConnectedServiceLaunchTargetActive(targetServerId: string | null | undefined): boolean {
    const target = String(targetServerId ?? '').trim();
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    return !target || areServerProfileIdentifiersEquivalent(target, activeServerId);
}

/** Throws when a non-active target's server profile or credentials are missing (never falls back). */
export async function resolveConnectedServiceLaunchServerScope(
    targetServerId: string | null | undefined,
): Promise<ConnectedServiceLaunchServerScope> {
    if (isConnectedServiceLaunchTargetActive(targetServerId)) return { kind: 'active' };
    const target = String(targetServerId).trim();
    const profile = getServerProfileById(resolveServerProfileScopeIdForIdentifier(target)) ?? getServerProfileById(target);
    if (!profile) throw new Error('connected_service_launch_target_server_profile_missing');
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
    if (!credentials) throw new Error('connected_service_launch_target_server_credentials_missing');
    return { kind: 'target', serverId: profile.id, serverUrl: profile.serverUrl, credentials };
}
