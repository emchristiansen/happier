import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { importConnectedServiceLogin } from './importConnectedServiceLogin';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

const scope = { machineId: 'machine-1', serverId: 'server-1', accountId: 'account-1' };

describe('native login import transport', () => {
    beforeEach(() => { machineRpc.mockReset(); });

    it('safely reports unavailable on an older daemon', async () => {
        machineRpc.mockRejectedValue(new RpcError('Method missing', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        await expect(importConnectedServiceLogin({ ...scope, request: { op: 'discover', serviceId: 'openai-codex' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'unsupported' });
    });

    it('accepts provider-declared sources and sends only nonsecret import choices', async () => {
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'discover', sources: [{ id: 'native', label: 'Native login' }] });
        const discovered = await importConnectedServiceLogin({ ...scope, request: { op: 'discover', serviceId: 'claude-subscription' } });
        expect(discovered).toEqual({ ok: true, op: 'discover', sources: [{ id: 'native', label: 'Native login' }] });
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'import', serviceId: 'claude-subscription', profileId: 'work' });
        const imported = await importConnectedServiceLogin({ ...scope, request: { op: 'import', serviceId: 'claude-subscription', profileId: 'work', source: 'native' } });
        expect(imported).toEqual({ ok: true, op: 'import', serviceId: 'claude-subscription', profileId: 'work' });
        expect(machineRpc.mock.calls[1]?.[0].payload).toEqual({ op: 'import', serviceId: 'claude-subscription', profileId: 'work', source: 'native' });
    });

    it('does not treat credentials or a different profile response as import success', async () => {
        const request = { op: 'import', serviceId: 'antigravity', profileId: 'work', source: 'acp' } as const;
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'import', serviceId: 'antigravity', profileId: 'other' });
        await expect(importConnectedServiceLogin({ ...scope, request })).resolves.toMatchObject({ ok: false, errorCode: 'storage_result_unknown' });
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'import', serviceId: 'antigravity', profileId: 'work', accessToken: 'unexpected-secret' });
        const result = await importConnectedServiceLogin({ ...scope, request });
        expect(result).toMatchObject({ ok: false, errorCode: 'storage_result_unknown' });
        expect(JSON.stringify(result)).not.toContain('unexpected-secret');
    });

    it('reports unknown storage after an import reply is lost without offering a safe retry', async () => {
        machineRpc.mockRejectedValue(new Error('Transport disconnected'));
        await expect(importConnectedServiceLogin({ ...scope, request: { op: 'import', serviceId: 'openai-codex', profileId: 'work', source: 'native' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'storage_result_unknown' });
    });
});
