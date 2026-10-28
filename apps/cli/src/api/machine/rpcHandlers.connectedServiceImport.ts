import { ConnectedServiceImportRequestV1Schema, type ConnectedServiceImportResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { runConnectedServiceImport, type ConnectedServiceImportAccount } from '@/cloud/connectedServices/connectedServiceImport';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

export function registerMachineConnectedServiceImportRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar; account?: ConnectedServiceImportAccount;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, async (
    raw: unknown, _compat?: unknown, context?: RpcHandlerContext,
  ): Promise<ConnectedServiceImportResponseV1> => {
    const parsed = ConnectedServiceImportRequestV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'Invalid import parameters.' };
    return await runConnectedServiceImport({ request: parsed.data, account: params.account, signal: context?.signal });
  });
}
