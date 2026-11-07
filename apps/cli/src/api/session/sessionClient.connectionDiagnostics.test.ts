import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import {
    createApiSessionSocketStub,
    type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import type { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import type { createUserScopedSocket } from './sockets';

type SessionSocketTransportResult = ReturnType<typeof createSessionSocketTransport>;
type UserScopedSocket = ReturnType<typeof createUserScopedSocket>;

const transportState = vi.hoisted(() => ({
    sessionSocket: null as ApiSessionSocketStub | null,
    userSocket: null as ApiSessionSocketStub | null,
}));

vi.mock('./sockets', () => ({
    createUserScopedSocket: () => {
        if (!transportState.userSocket) throw new Error('Missing user socket stub');
        return transportState.userSocket as unknown as UserScopedSocket;
    },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => {
        if (!transportState.sessionSocket) throw new Error('Missing session socket stub');
        const socket = transportState.sessionSocket;
        return {
            socket: socket as unknown as SessionSocketTransportResult['socket'],
            transport: {
                connect: async () => {
                    throw new Error('connect failed Authorization: Bearer SESSION_SOCKET_SECRET');
                },
                disconnect: async () => {},
                destroy: async () => {},
                isConnected: () => false,
                onConnected: () => () => {},
                onDisconnected: () => () => {},
                onError: () => () => {},
            },
        } satisfies SessionSocketTransportResult;
    },
}));

describe('ApiSessionClient connection diagnostics', () => {
    beforeEach(() => {
        transportState.sessionSocket = createApiSessionSocketStub({ connected: false });
        transportState.userSocket = createApiSessionSocketStub({ connected: false });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('records supervised initial socket failures in normal session file logs without leaking credentials', async () => {
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const { ApiSessionClient } = await import('./sessionClient');
        const client = new ApiSessionClient('token-1', createPlainSessionFixture({ id: 'session-1' }));

        try {
            await expect.poll(() => infoFileSpy.mock.calls.find(([message, details]) => (
                message === '[API] Session socket connection state'
                && typeof details === 'object'
                && details !== null
                && (details as { phase?: unknown }).phase === 'offline'
            ))?.[1]).toMatchObject({
                phase: 'offline',
                reason: 'server_unreachable',
                attempt: 1,
                nextRetryAt: expect.any(Number),
                lastErrorMessage: 'connect failed authorization: bearer [REDACTED]',
            });

            expect(JSON.stringify(infoFileSpy.mock.calls)).not.toContain('SESSION_SOCKET_SECRET');
        } finally {
            await client.close();
        }
    });
});
