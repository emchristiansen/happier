import {
    ConnectedServiceImportResponseV1Schema,
    type ConnectedServiceImportRequestV1,
    type ConnectedServiceImportResponseV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** Native credentials stay on the selected daemon; this transport carries only choices and status. */
export async function importConnectedServiceLogin(params: Readonly<{
    machineId: string;
    serverId: string;
    accountId: string;
    request: ConnectedServiceImportRequestV1;
}>): Promise<ConnectedServiceImportResponseV1> {
    const unavailable = { ok: false, errorCode: 'unsupported', error: 'Native login import is unavailable on this machine.' } as const;
    const failed = { ok: false, errorCode: 'import_failed', error: 'Native login import failed.' } as const;
    const unknown = { ok: false, errorCode: 'storage_result_unknown', error: 'The import result is unknown. Refresh the profile before retrying.' } as const;
    const missingResult = params.request.op === 'import' ? unknown : failed;
    try {
        const raw = await machineRpcWithServerScope<unknown, ConnectedServiceImportRequestV1>({
            machineId: params.machineId,
            serverId: params.serverId,
            accountId: params.accountId,
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT,
            payload: params.request,
        });
        if (isRpcMethodNotFoundResult(raw)) return unavailable;
        const parsed = ConnectedServiceImportResponseV1Schema.safeParse(raw);
        if (!parsed.success) return missingResult;
        const result = parsed.data;
        if (!result.ok) return result;
        if (result.op !== params.request.op) return missingResult;
        if (result.op === 'import' && params.request.op === 'import'
            && (result.serviceId !== params.request.serviceId || result.profileId !== params.request.profileId)) return missingResult;
        return result;
    } catch (error) {
        const code = readRpcErrorCode(error);
        return code === RPC_ERROR_CODES.METHOD_NOT_FOUND || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE ? unavailable : missingResult;
    }
}
