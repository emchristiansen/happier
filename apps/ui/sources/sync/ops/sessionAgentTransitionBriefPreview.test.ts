import { describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
// The socket transport is the system boundary; payload and response parsing stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
import { previewSessionAgentTransitionBriefOnMachine } from './sessionAgentTransitionBriefPreview';

describe('configured continuation brief preview', () => {
    it('rebuilds the boundary using exact configured identities', async () => {
        const sourceBackendTarget = { kind: 'configuredAcpBackend', backendId: 'a' } as const;
        const targetBackendTarget = { kind: 'configuredAcpBackend', backendId: 'b' } as const;
        machineRpcWithServerScope.mockImplementation(async (request: { payload: unknown }) => {
            expect(request.payload).toMatchObject({ sourceBackendTarget, targetBackendTarget });
            return { type: 'rebuilt', protocolVersion: 1, briefText: 'context for B' };
        });
        await expect(previewSessionAgentTransitionBriefOnMachine({
            machineId: 'machine-1', serverId: 'server-1', sessionId: 'session-1',
            sourceCutoffSeqInclusive: 12, returningAgentLastSeenSeqInclusive: null,
            sourceAgentId: 'customAcp', targetAgentId: 'customAcp', sourceBackendTarget, targetBackendTarget,
        })).resolves.toEqual({ status: 'answered', preview: { type: 'rebuilt', protocolVersion: 1, briefText: 'context for B' } });
    });
});
