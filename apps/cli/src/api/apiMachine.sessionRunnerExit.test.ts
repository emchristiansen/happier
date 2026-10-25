import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';

// Wire name shared with the relay server's machine-scoped socket handler.
const MACHINE_SESSION_RUNNER_EXITED_EVENT = 'machine-session-runner-exited';

function createClient(socket: unknown): ApiMachineClient {
    const machine: Machine = {
        id: 'machine-runner-exit',
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
    const client = new ApiMachineClient('token', machine);
    Reflect.set(client, 'socket', socket);
    return client;
}

describe('ApiMachineClient session runner exit report', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports the exited session over the machine socket and returns the server acknowledgement', async () => {
        const emitWithAck = vi.fn(async () => ({ status: 'closed', sessionId: 'session-exited' }));
        const client = createClient({ connected: true, timeout: () => ({ emitWithAck }), emitWithAck });

        await expect(client.reportSessionRunnerExited({
            sessionId: 'session-exited',
            publisherIncarnationId: 'incarnation-a',
        })).resolves.toEqual({
            kind: 'acknowledged',
            ack: { status: 'closed', sessionId: 'session-exited' },
        });
        expect(emitWithAck).toHaveBeenCalledWith(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
            sessionId: 'session-exited',
            publisherIncarnationId: 'incarnation-a',
        });
    });

    it('settles as not delivered when the server never acknowledges the report', async () => {
        // A relay that predates the report (e.g. a357c655) silently ignores the unknown event.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const emitWithAck = vi.fn(() => new Promise<unknown>(() => {}));
        const client = createClient({ connected: true, timeout: () => ({ emitWithAck }), emitWithAck });

        const outcome = client.reportSessionRunnerExited({
            sessionId: 'session-old-server',
            publisherIncarnationId: 'incarnation-a',
        });
        await vi.advanceTimersByTimeAsync(60_000);

        await expect(outcome).resolves.toEqual({ kind: 'not_delivered', reason: 'unacknowledged' });
    });

    it('does not queue a report for later delivery while the machine socket is disconnected', async () => {
        const emitWithAck = vi.fn(async () => ({ status: 'closed', sessionId: 'session-offline' }));
        const client = createClient({ connected: false, timeout: () => ({ emitWithAck }), emitWithAck });

        await expect(client.reportSessionRunnerExited({
            sessionId: 'session-offline',
            publisherIncarnationId: 'incarnation-a',
        })).resolves.toEqual({
            kind: 'not_delivered',
            reason: 'socket_not_connected',
        });
        expect(emitWithAck).not.toHaveBeenCalled();
    });
});
