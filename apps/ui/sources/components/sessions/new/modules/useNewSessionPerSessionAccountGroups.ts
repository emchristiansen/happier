import * as React from 'react';

import {
    CONNECTED_SERVICE_AUTH_GROUP_PER_SESSION_SOFTMAX_SERVICE_IDS,
    type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';

import { useConnectedServiceAuthGroupsQuery } from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export type NewSessionAccountGroupsByServiceId = Readonly<Record<string, ReadonlyArray<ConnectedServiceAuthGroupV1> | undefined>>;

/**
 * Authoritative V3 groups for the services that support per-session pools, read only when the launch
 * server supports the strategy. The account profile projection carries no policy, so without these
 * groups the new-session picker cannot tell a per-session pool (which offers "Start on") from a shared
 * one (spec A.1). Returns undefined while unsupported, disabled, or not yet loaded.
 */
export function useNewSessionPerSessionAccountGroups(params: Readonly<{
    targetServerId: string | null;
    accountGroupsFeatureEnabled: boolean;
    supportedConnectedServiceIds: ReadonlyArray<string>;
    serviceProjectionSignature: string;
}>): NewSessionAccountGroupsByServiceId | undefined {
    const perSessionSoftmaxEnabled = useFeatureEnabled('connectedServices.poolPerSessionSoftmax', {
        scopeKind: 'spawn',
        serverId: params.targetServerId,
    });
    // The per-session service list is a frozen constant, so this per-service hook call order is stable.
    const queries = CONNECTED_SERVICE_AUTH_GROUP_PER_SESSION_SOFTMAX_SERVICE_IDS.map((serviceId) => {
        const enabled = params.accountGroupsFeatureEnabled
            && perSessionSoftmaxEnabled
            && params.supportedConnectedServiceIds.includes(serviceId);
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const query = useConnectedServiceAuthGroupsQuery({
            serviceId: enabled ? serviceId : null,
            enabled,
            serviceProjectionSignature: params.serviceProjectionSignature,
            // The pools (policy and members) are the launch server's, not the Home server's.
            targetServerId: params.targetServerId,
        });
        const loaded = enabled && (query.loadStatus === 'loaded' || query.loadStatus === 'refreshing');
        return { serviceId, groups: loaded ? query.groups : null };
    });

    const groupsList = queries.map((query) => query.groups);
    return React.useMemo(() => {
        const out: Record<string, ReadonlyArray<ConnectedServiceAuthGroupV1>> = {};
        queries.forEach((query) => {
            if (query.groups) out[query.serviceId] = query.groups;
        });
        return Object.keys(out).length > 0 ? out : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, groupsList);
}
