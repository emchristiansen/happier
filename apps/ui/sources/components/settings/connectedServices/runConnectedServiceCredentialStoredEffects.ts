import type { ConnectedServiceId } from '@happier-dev/protocol';

import { sync } from '@/sync/sync';

import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';

export async function runConnectedServiceCredentialStoredEffects(_params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<void> {
    await sync.refreshProfile();
    invalidateConnectedServiceGroupsRefreshSignal();
}
