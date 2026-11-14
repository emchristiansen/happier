import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { HappyError } from '@/utils/errors/errors';

/**
 * The connected-service projection (services, profiles, health, group membership) of the account on
 * one specific server, read with that server's credentials. Used for a launch target other than the
 * active server, whose projection the active account profile does not describe.
 */
export async function fetchAccountConnectedServicesForServer(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl: string;
}>): Promise<AccountProfile['connectedServicesV2']> {
    const serverUrl = params.serverUrl.trim().replace(/\/+$/, '');
    const response = await runtimeFetchWithServerReachability({
        serverUrl,
        token: params.credentials.token,
        url: `${serverUrl}/v1/account/profile`,
        init: {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${params.credentials.token}`,
                'Content-Type': 'application/json',
            },
        },
    });
    if (!response.ok) {
        throw new HappyError(`Failed to fetch launch server profile (${response.status})`, false, { status: response.status, kind: 'server' });
    }
    const parsed = AccountProfileSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
        throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return parsed.data.connectedServicesV2;
}
