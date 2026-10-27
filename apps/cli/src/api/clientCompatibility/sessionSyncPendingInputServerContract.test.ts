import { describe, expect, it, vi } from 'vitest';

import {
    createSessionSyncPendingInputServerContractController,
    resolveSessionServerCapabilities,
} from './sessionSyncPendingInputServerContract';

function features(params: Readonly<{
    runtimeActivity?: number;
    pendingInput?: number;
    exactLocalId?: number;
}> = { runtimeActivity: 2, pendingInput: 1 }) {
    return {
        features: {
            sharing: {
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
            },
        },
        capabilities: {
            session: {
                ...(params.runtimeActivity === undefined ? {} : {
                    runtimeActivity: { protocolVersion: params.runtimeActivity },
                }),
                ...(params.pendingInput === undefined ? {} : {
                    pendingInput: {
                        protocolVersion: params.pendingInput,
                    },
                }),
                ...(params.exactLocalId === undefined ? {} : {
                    pendingInputExactLocalId: { protocolVersion: params.exactLocalId },
                }),
            },
        },
    };
}

const releasedServerV021Features = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    },
    capabilities: {},
};

function response(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('session server capability selection', () => {
    it('selects Runtime Activity and Pending-input independently', () => {
        expect(resolveSessionServerCapabilities(features({ runtimeActivity: 2 }))).toEqual({
            runtimeActivity: 'v2',
            pendingInput: 'unsupported',
            pendingExactLocalId: 'unsupported',
        });
        expect(resolveSessionServerCapabilities(features({ pendingInput: 1 }))).toEqual({
            runtimeActivity: 'unsupported',
            pendingInput: 'v1',
            pendingExactLocalId: 'unsupported',
        });
    });

    it('requires the exact-local-id capability in addition to the older pending protocol version', () => {
        expect(resolveSessionServerCapabilities(features({ pendingInput: 2 }))).toMatchObject({
            pendingInput: 'v1',
            pendingExactLocalId: 'unsupported',
        });
        expect(resolveSessionServerCapabilities(features({ runtimeActivity: 2, pendingInput: 2, exactLocalId: 1 }))).toEqual({
            runtimeActivity: 'v2',
            pendingInput: 'v1',
            pendingExactLocalId: 'v1',
        });
        expect(resolveSessionServerCapabilities(features({ exactLocalId: 1 }))).toEqual({
            runtimeActivity: 'unsupported',
            pendingInput: 'unsupported',
            pendingExactLocalId: 'unsupported',
        });
    });

    it('recognizes the immutable released v0.2.1 fallback', () => {
        expect(resolveSessionServerCapabilities(releasedServerV021Features)).toEqual({
            runtimeActivity: 'legacy',
            pendingInput: 'released_server_v0_2_1',
            pendingExactLocalId: 'unsupported',
        });
    });

    it('uses one header-safe features request and no socket ping proof', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response(features()));
        const socket = {
            connected: true,
            emitWithAck: vi.fn(),
        };
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl,
        });

        await expect(controller.resolve({
            sessionConnectionEpoch: 1,
            socket,
            machineId: 'machine-1',
        })).resolves.toMatchObject({
            mode: 'session_sync_v2_pending_input_v1',
            runtimeActivity: 'v2',
            pendingInput: 'v1',
            pendingExactLocalId: 'unsupported',
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://server.example/v1/features',
            expect.objectContaining({
                headers: { Authorization: 'Bearer token' },
            }),
        );
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it.each([[401], [403]] as const)('classifies HTTP %s as auth_failed', async (status) => {
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response({}, status)),
        });
        await expect(controller.resolve({
            sessionConnectionEpoch: 1,
            socket: { connected: true },
            machineId: 'machine-1',
        })).resolves.toMatchObject({
            mode: 'auth_failed',
            runtimeActivity: 'indeterminate',
            pendingInput: 'indeterminate',
            pendingExactLocalId: 'indeterminate',
        });
    });

    it('re-probes after a settled indeterminate feature request', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({}, 503))
            .mockResolvedValueOnce(response(features()));
        const socket = { connected: true };
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl,
        });
        const probe = { sessionConnectionEpoch: 1, socket, machineId: 'machine-1' };

        await expect(controller.resolve(probe)).resolves.toMatchObject({ mode: 'indeterminate' });
        await expect(controller.resolve(probe)).resolves.toMatchObject({
            mode: 'session_sync_v2_pending_input_v1',
            runtimeActivity: 'v2',
            pendingInput: 'v1',
            pendingExactLocalId: 'unsupported',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('invalidates an in-flight result when the socket epoch changes', async () => {
        let release: ((value: Response) => void) | undefined;
        const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
        const socket = { connected: true };
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl,
        });
        const pending = controller.resolve({
            sessionConnectionEpoch: 4,
            socket,
            machineId: 'machine-1',
        });
        expect(controller.invalidate({ sessionConnectionEpoch: 4, socket })).toMatchObject({
            runtimeActivity: 'indeterminate',
            pendingInput: 'indeterminate',
            pendingExactLocalId: 'indeterminate',
        });
        release?.(response(features()));
        await expect(pending).resolves.toMatchObject({
            runtimeActivity: 'indeterminate',
            pendingInput: 'indeterminate',
            pendingExactLocalId: 'indeterminate',
        });
    });
});
