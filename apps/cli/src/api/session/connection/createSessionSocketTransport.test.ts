import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TransportDisconnectEvent } from '@happier-dev/connection-supervisor';
import axios from 'axios';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('axios');

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

describe('createSessionSocketTransport', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
    });

    it('creates a non-reconnecting socket transport and reports manual disconnects as intentional', async () => {
        const socket = createApiSessionSocketStub({ disconnectReason: 'io client disconnect' });
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { socket: transportSocket, transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(transportSocket).toBe(socket);
        const opts = mockIo.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(opts.reconnection).toBe(false);
        expect(opts.autoConnect).toBe(false);
        // The publisher names this runner process, so the daemon's later exit report can match it exactly.
        const { getRunnerPublisherIncarnationId } = await import('@/api/session/publisherIncarnation');
        const runnerPublisherIncarnationId = getRunnerPublisherIncarnationId();
        expect(opts.auth).toMatchObject({ publisherIncarnationId: runnerPublisherIncarnationId });
        expect(runnerPublisherIncarnationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(opts.auth).toMatchObject({ connectedServiceIds: ConnectedServiceIdSchema.options });

        const connectedListener = vi.fn();
        const disconnectedListener = vi.fn<(event: TransportDisconnectEvent) => void>();
        transport.onConnected(connectedListener);
        transport.onDisconnected(disconnectedListener);

        await transport.connect();
        expect(connectedListener).toHaveBeenCalledTimes(1);

        await transport.disconnect({ intentional: true });
        expect(disconnectedListener).toHaveBeenCalledWith(
            expect.objectContaining({
                intentional: true,
                reason: 'io client disconnect',
            }),
        );
    });

    it('ensures a machine-bound session access key before connecting a session-scoped socket', async () => {
        const socket = createApiSessionSocketStub();
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: null } } as never);
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await transport.connect();

        expect(axios.get).toHaveBeenCalledWith(
            'http://127.0.0.1:4321/v1/access-keys/session-1/machine-1',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
        expect(axios.post).toHaveBeenCalledWith(
            'http://127.0.0.1:4321/v1/access-keys/session-1/machine-1',
            expect.objectContaining({
                data: expect.any(String),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
        expect(socket.connect).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent access-key bootstrap requests for the same machine-bound session', async () => {
        const socketA = createApiSessionSocketStub({ id: 'sock-a' });
        const socketB = createApiSessionSocketStub({ id: 'sock-b' });
        mockIo
            .mockReset()
            .mockImplementationOnce(() => socketA)
            .mockImplementationOnce(() => socketB)
            .mockImplementation(() => socketB);

        const pendingGet = new Promise((resolve) => {
            setTimeout(() => resolve({ status: 200, data: { accessKey: null } }), 0);
        });
        vi.mocked(axios.get).mockReturnValue(pendingGet as never);
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const first = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });
        const second = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await Promise.all([
            first.transport.connect(),
            second.transport.connect(),
        ]);

        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(socketA.connect).toHaveBeenCalledTimes(1);
        expect(socketB.connect).toHaveBeenCalledTimes(1);
    });

    it('reuses a recent successful access-key bootstrap for the same machine-bound session', async () => {
        const socketA = createApiSessionSocketStub({ id: 'sock-a' });
        const socketB = createApiSessionSocketStub({ id: 'sock-b' });
        mockIo
            .mockReset()
            .mockImplementationOnce(() => socketA)
            .mockImplementationOnce(() => socketB)
            .mockImplementation(() => socketB);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        await createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        }).transport.connect();
        await createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        }).transport.connect();

        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.post).not.toHaveBeenCalled();
        expect(socketA.connect).toHaveBeenCalledTimes(1);
        expect(socketB.connect).toHaveBeenCalledTimes(1);
    });

    it('does not resolve connect until the session-scoped socket has actually connected', async () => {
        const socket = createApiSessionSocketStub();
        socket.connect.mockImplementation(() => socket);
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        let resolved = false;
        const connectPromise = transport.connect().then(() => {
            resolved = true;
        });

        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
        expect(resolved).toBe(false);

        socket.connected = true;
        socket.trigger('connect');
        await connectPromise;

        expect(resolved).toBe(true);
    });

    it('rejects connect when the session-scoped socket reports a connect error', async () => {
        const socket = createApiSessionSocketStub();
        socket.connect.mockImplementation(() => socket);
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        const connectPromise = transport.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
        const error = new Error('socket auth failed');
        socket.trigger('connect_error', error);

        await expect(connectPromise).rejects.toThrow('socket auth failed');
    });

    it('preserves terminal auth failures from the access-key bootstrap request', async () => {
        const socket = createApiSessionSocketStub();
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockResolvedValue({ status: 401, data: { error: 'Unauthorized' } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await expect(transport.connect()).rejects.toMatchObject({
            response: { status: 401 },
        });
        expect(socket.connect).not.toHaveBeenCalled();
    });
});
