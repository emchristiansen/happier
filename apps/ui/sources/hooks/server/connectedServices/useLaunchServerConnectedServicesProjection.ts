import * as React from 'react';

import type { AccountProfile } from '@happier-dev/protocol';

import { fetchAccountConnectedServicesForServer } from '@/sync/api/account/apiAccountConnectedServicesForServer';
import { useConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import {
    isConnectedServiceLaunchTargetActive,
    resolveConnectedServiceLaunchServerScope,
} from '@/sync/domains/connectedServices/resolveConnectedServiceLaunchServerScope';
import { useProfile } from '@/sync/store/hooks';

type ConnectedServicesV2 = AccountProfile['connectedServicesV2'];

/**
 * The connected-service projection of the launch server. Home's comes from the synced account
 * profile; another target's is read from that server. While a target is loading or failed there is
 * no projection at all (`connectedServicesV2: null`): it is never answered with Home's.
 */
export type LaunchServerConnectedServicesProjection =
    | Readonly<{ status: 'home'; connectedServicesV2: ConnectedServicesV2 }>
    | Readonly<{ status: 'target_loading' | 'target_error'; connectedServicesV2: null }>
    | Readonly<{ status: 'target_loaded'; connectedServicesV2: ConnectedServicesV2 }>;

const EMPTY: ConnectedServicesV2 = [];

type TargetState =
    | Readonly<{ key: string; status: 'target_loading' | 'target_error' }>
    | Readonly<{ key: string; status: 'target_loaded'; connectedServicesV2: ConnectedServicesV2 }>;

export function useLaunchServerConnectedServicesProjection(params: Readonly<{
    targetServerId: string | null;
    enabled: boolean;
}>): LaunchServerConnectedServicesProjection {
    const homeProfile = useProfile();
    const refreshSignal = useConnectedServiceGroupsRefreshSignal();
    const isHome = isConnectedServiceLaunchTargetActive(params.targetServerId);
    const targetKey = isHome || !params.enabled ? null : String(params.targetServerId).trim();
    const [target, setTarget] = React.useState<TargetState | null>(null);

    React.useEffect(() => {
        if (!targetKey) return;
        let cancelled = false;
        setTarget((prev) => (prev?.key === targetKey && prev.status === 'target_loaded' ? prev : { key: targetKey, status: 'target_loading' }));
        void (async () => {
            const scope = await resolveConnectedServiceLaunchServerScope(targetKey);
            if (scope.kind !== 'target') throw new Error('connected_service_launch_target_became_active');
            return await fetchAccountConnectedServicesForServer({ credentials: scope.credentials, serverUrl: scope.serverUrl });
        })().then(
            (connectedServicesV2) => {
                if (!cancelled) setTarget({ key: targetKey, status: 'target_loaded', connectedServicesV2 });
            },
            () => {
                if (!cancelled) {
                    console.warn('[connectedServices] Failed to load the launch server connected services', { targetServerId: targetKey });
                    setTarget({ key: targetKey, status: 'target_error' });
                }
            },
        );
        return () => { cancelled = true; };
    }, [targetKey, refreshSignal]);

    const homeConnectedServicesV2 = homeProfile?.connectedServicesV2 ?? EMPTY;
    return React.useMemo<LaunchServerConnectedServicesProjection>(() => {
        if (!targetKey) return { status: 'home', connectedServicesV2: isHome ? homeConnectedServicesV2 : EMPTY };
        // A state for a different (previous) target is never shown for this one.
        if (!target || target.key !== targetKey) return { status: 'target_loading', connectedServicesV2: null };
        if (target.status === 'target_loaded') return { status: 'target_loaded', connectedServicesV2: target.connectedServicesV2 };
        return { status: target.status, connectedServicesV2: null };
    }, [homeConnectedServicesV2, isHome, target, targetKey]);
}
