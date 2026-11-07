import { ConnectedServiceBindingsV1Schema, RELEASED_CONNECTED_SERVICE_IDS, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { machineCapabilitiesInvoke } from './capabilities';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const releasedServiceIds: ReadonlySet<string> = new Set(RELEASED_CONNECTED_SERVICE_IDS);

export class ConnectedServiceAuthSelectionUnsupportedError extends Error {
    constructor() {
        super('The daemon cannot launch this connected account selection. Update or reconnect the CLI on the selected machine.');
        this.name = 'ConnectedServiceAuthSelectionUnsupportedError';
    }
}

export async function requireMachineConnectedServiceAuthSelection(params: Parameters<typeof machineSupportsConnectedServiceAuthSelection>[0]): Promise<void> {
    if (!await machineSupportsConnectedServiceAuthSelection(params)) {
        throw new ConnectedServiceAuthSelectionUnsupportedError();
    }
}

/** Every session creator/adopter sends through the same connected-account admission boundary. */
export async function machineRpcWithConnectedServiceAuthAdmission<A>(
    params: ServerScopedMachineRpcParams<A>,
    auth: Readonly<{ backendTarget: BackendTargetRefV1; connectedServices: unknown }>,
): Promise<unknown> {
    await requireMachineConnectedServiceAuthSelection({
        machineId: params.machineId,
        serverId: params.serverId,
        accountId: params.accountId,
        ...auth,
    });
    return await machineRpcWithServerScope<unknown, A>(params);
}

export async function getMachineConnectedServiceAuthSupportedServiceIds(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    agentId: string;
}>): Promise<readonly string[]> {
    const response = await machineCapabilitiesInvoke(params.machineId, {
        id: `cli.${params.agentId}`,
        method: 'connectedServiceAuthSupport',
        params: {},
    }, { serverId: params.serverId, accountId: params.accountId });
    if (!response.supported || !response.response.ok) return [];
    const result = response.response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const supportedServiceIds = (result as Record<string, unknown>).supportedServiceIds;
    return Array.isArray(supportedServiceIds) && supportedServiceIds.every((id) => typeof id === 'string') ? supportedServiceIds : [];
}

/** The daemon's registered materializer owns launch support, independently of UI catalogs. */
export async function machineSupportsConnectedServiceAuthSelection(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    backendTarget: BackendTargetRefV1;
    connectedServices: unknown;
}>): Promise<boolean> {
    if (params.connectedServices === undefined || params.connectedServices === null) return true;
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(params.connectedServices);
    if (!parsed.success) return false;
    const requiredServiceIds = Object.entries(parsed.data.bindingsByServiceId)
        .filter(([serviceId, binding]) => binding.source === 'connected' && !releasedServiceIds.has(serviceId))
        .map(([serviceId]) => serviceId);
    if (requiredServiceIds.length === 0) return true;
    if (params.backendTarget.kind !== 'builtInAgent') return false;
    const supportedServiceIds = await getMachineConnectedServiceAuthSupportedServiceIds({
        machineId: params.machineId,
        serverId: params.serverId,
        accountId: params.accountId,
        agentId: params.backendTarget.agentId,
    });
    return requiredServiceIds.every((id) => supportedServiceIds.includes(id));
}
