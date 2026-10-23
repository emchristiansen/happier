import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Manager } from 'socket.io-client';
import { serializeOutboundError } from './outboundErrorSerialization';

import {
    blockPendingQueueV2Delivery,
    enqueuePendingQueueV2MessageViaHttp,
    readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
    readPendingQueueV2ActivationEligibilityFromServer,
    listPendingQueueV2LocalIdsFromServer,
    listPendingQueueV2ActionableLocalIdsFromServer,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    markPendingQueueV2DeliveryHandled,
    readPendingQueueV2RowSnapshotsFromServer,
    materializeNextPendingQueueV2Message,
    materializeNextPendingQueueV2MessageOnReleasedServer,
    materializeNextPendingQueueV2MessageViaHttp,
    PendingQueueMaterializationTransportAmbiguousError,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    isAcceptedPendingQueueV2DeliveryRetryableError,
    resolveAcceptedPendingQueueV2Delivery,
} from './pendingQueueV2Transport';

const { mockGet, mockPost } = vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mockGet,
        post: mockPost,
        isAxiosError: (error: unknown) => Boolean(
            error && typeof error === 'object' && (error as { isAxiosError?: unknown }).isAxiosError === true,
        ),
    },
}));

describe('pendingQueueV2Transport', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
    });

    it('waits 30 s for a Pending enqueue acknowledgement', async () => {
        mockPost.mockResolvedValueOnce({ data: { didWrite: true } });

        await enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: { localId: 'local-1', ciphertext: 'cipher', requestedAction: { v: 1, kind: 'enqueue' } },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending'),
            expect.anything(),
            expect.objectContaining({ timeout: 30_000 }),
        );
    });

    it('accepts a terminal enqueue rejoin only with the exact committed-message localId', async () => {
        const localId = ' exact-cli-local ';
        const requestedAction = { v: 1, kind: 'enqueue' } as const;
        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: { id: 'message-1', seq: 5, localId, requestedAction },
            },
        });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).resolves.toEqual({ didWrite: false, terminal: true, suppressed: false });

        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: { id: 'message-1', seq: 5, localId: 'different-local', requestedAction },
            },
        });
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).rejects.toThrow('Invalid Pending enqueue terminal proof');

        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: {
                    id: 'message-1',
                    seq: 5,
                    localId,
                    requestedAction: { v: 1, kind: 'send_now' },
                },
            },
        });
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).rejects.toThrow('Invalid Pending enqueue terminal proof');
    });

    it('preserves conditional continuation admission and parses suppression', async () => {
        mockPost.mockResolvedValueOnce({
            data: { didWrite: false, suppressed: true },
        });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId: 'connected-service-continuation:test',
                ciphertext: 'cipher',
                requestedAction: { v: 1, kind: 'send_now' },
                deliveryMode: 'continuation_if_no_queued_user_input',
            },
        })).resolves.toEqual({ didWrite: false, terminal: false, suppressed: true });
        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending'),
            expect.objectContaining({
                localId: 'connected-service-continuation:test',
                deliveryMode: 'continuation_if_no_queued_user_input',
            }),
            expect.any(Object),
        );
    });

    it('rejects whitespace-only enqueue identity before transport', async () => {
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId: ' \t\r\n ',
                ciphertext: 'cipher',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        })).rejects.toThrow('Pending localId must not be blank');
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only action and settlement identities before transport', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
            reason: 'payload_too_large',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');

        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('degrades a new conditional-steer settlement to a strict block on an older server', async () => {
        mockPost
            .mockRejectedValueOnce({
                isAxiosError: true,
                response: { status: 400, data: { error: 'Bad Request' } },
            })
            .mockResolvedValueOnce({
                data: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
            });

        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'conditional-steer-1',
            reason: 'conditional_steer_unavailable',
        })).resolves.toMatchObject({ usedLegacySteeringUnavailableFallback: true });

        expect(mockPost).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('/delivery/block'),
            { reason: 'conditional_steer_unavailable' },
            expect.any(Object),
        );
        expect(mockPost).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('/delivery/block'),
            { reason: 'steering_unavailable' },
            expect.any(Object),
        );
    });

    it('emits only the immutable released materialize payload and accepts its exact positive ACK', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'message-1', seq: 4, localId: 'local-1' },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(materializeNextPendingQueueV2MessageOnReleasedServer({
            sessionId: 'session-1',
            socket: socket as any,
        })).resolves.toEqual({
            ok: true,
            didMaterialize: true,
            didWrite: true,
            message: { id: 'message-1', seq: 4, localId: 'local-1' },
        });
        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 'session-1' });
    });

    it.each([
        { ok: true, didMaterialize: false, extra: true },
        { ok: true, didMaterialize: true, message: { id: 'message-1', seq: 4, localId: 'local-1' } },
        { ok: true, didMaterialize: true, didWrite: true, message: { id: '', seq: 4, localId: 'local-1' } },
        { ok: true, didMaterialize: true, didWrite: true, message: { id: 'message-1', seq: -1, localId: 'local-1' } },
        { ok: false, error: 'unknown' },
        { ok: false, error: 'forbidden', extra: true },
        { ok: true, didMaterialize: false, pendingCount: 0 },
    ])('rejects a non-exact released ACK %#', async (ack) => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue(ack),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(materializeNextPendingQueueV2MessageOnReleasedServer({
            sessionId: 'session-1',
            socket: socket as any,
        })).rejects.toThrow('Invalid released server pending materialize acknowledgement');
    });

    it('reads only the accepted-settlement overload directive with typed delay before Retry-After', () => {
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 503,
                headers: { 'Retry-After': '9' },
                data: {
                    error: 'transaction-unavailable',
                    retryAfterMs: 1_250,
                    correlationId: 'req-accepted-busy',
                },
            },
        })).toEqual({
            retryAfterMs: 1_250,
            correlationId: 'req-accepted-busy',
        });
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 503,
                headers: { 'Retry-After': '2.5' },
                data: { error: 'transaction-unavailable' },
            },
        })).toEqual({ retryAfterMs: 2_500 });
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 500,
                headers: { 'Retry-After': '1' },
                data: { error: 'internal', correlationId: 'req-generic-500' },
            },
        })).toBeNull();
    });

    it('fails closed instead of using HTTP provider materialization when the selected socket disconnects', async () => {
        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
        });

        await expect(materialization).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_socket_disconnected',
            classification: 'socket_disconnected',
        });
        await expect(materialization).rejects.toBeInstanceOf(PendingQueueMaterializationTransportAmbiguousError);

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('sends runtime-idle delivery timing in HTTP materialization requests', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'waiting_for_runtime_activity',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 41,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_runtime_activity',
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 41,
        });
    });

    it('preserves the server-owned unknown-activity deadline over HTTP materialization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_unknown',
                retryAfterMs: 29_750,
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_unknown',
            retryAfterMs: 29_750,
        });
    });

    it('preserves unresolved-head backpressure from HTTP materialization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 7,
                deferredReason: 'waiting_for_predecessor',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_predecessor',
            pendingQueueState: {
                known: true,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 7,
            },
        });
    });

    it('fails closed when provider delivery opt-in is rejected instead of falling back to legacy materialization', async () => {
        const error = { response: { status: 400 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed through explicit HTTP materialization when no session socket is selected', async () => {
        const error = { response: { status: 422 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('returns a fail-closed contract result for HTTP materialization without a provider action', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-local',
                didWriteMessage: true,
                pendingCount: 0,
                pendingVersion: 3,
                message: {
                    id: 'm-legacy',
                    seq: 42,
                    localId: 'legacy-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy prompt' },
                            localId: 'legacy-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'legacy-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed on a missing provider action even when the legacy opt-in flag is false', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'hard-cutover-local',
                didWriteMessage: false,
                pendingCount: 0,
                pendingVersion: 3,
                message: {
                    id: null,
                    seq: null,
                    localId: 'hard-cutover-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'hard cutover prompt' },
                            localId: 'hard-cutover-local',
                        },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: false,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'hard-cutover-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('returns a fail-closed contract result for socket materialization without a provider action', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'legacy-socket-local',
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 4,
                message: {
                    id: 'm-legacy-socket',
                    seq: 43,
                    localId: 'legacy-socket-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy socket prompt' },
                            localId: 'legacy-socket-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'legacy-socket-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryState: 'provider',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('sends runtime-idle delivery timing in socket materialization requests', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'waiting_for_runtime_activity',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_runtime_activity',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves the server-owned unknown-activity deadline over socket materialization', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_unknown',
                retryAfterMs: 29_750,
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_unknown',
            retryAfterMs: 29_750,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });


    it('preserves unresolved-head backpressure from socket materialization', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 9,
                deferredReason: 'waiting_for_predecessor',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_predecessor',
            pendingQueueState: { pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 },
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('does not redrive through HTTP after a connected socket response is lost', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => {
                throw new Error('socket response lost');
            }),
        };
        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            expectedPendingVersion: 7,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_transport_failure',
            classification: 'transport_failure',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            expectedPendingVersion: 7,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('does not redrive through HTTP after an invalid connected socket ACK', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({ ok: 'not-a-boolean' })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_ack_malformed',
            classification: 'malformed_ack',
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves a typed negative materialization ACK as a safe server rejection diagnostic', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({ ok: false, error: 'forbidden' })),
        };

        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
        });

        await expect(materialization).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_server_rejected',
            classification: 'server_rejected',
            serverError: 'forbidden',
        });
        const error = await materialization.catch((cause) => cause);
        expect(serializeOutboundError(error)).toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            message: 'Connected pending queue materialization did not return a valid acknowledgement',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('classifies a forbidden opted-in session-socket ACK as a lost publisher, not a transport retry', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({ ok: false, error: 'forbidden' })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_publisher_lost',
            classification: 'publisher_lost',
            serverError: 'forbidden',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves a typed transaction-unavailable materialization ACK and its server retry delay', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: false,
                error: 'transaction-unavailable',
                retryAfterMs: 1_000,
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_server_retryable',
            classification: 'server_retryable',
            serverError: 'transaction-unavailable',
            retryAfterMs: 1_000,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('classifies a missing materialization ACK at the local deadline and preserves its safe cause', async () => {
        vi.useFakeTimers();
        try {
            const socket = {
                connected: true,
                timeout: vi.fn(() => socket),
                emitWithAck: vi.fn(() => new Promise<never>(() => {})),
            };
            const materialization = materializeNextPendingQueueV2Message({
                token: 'token',
                sessionId: 'session-1',
                socket: socket as any,
            });
            const observed = materialization.catch((error) => error);

            await vi.advanceTimersByTimeAsync(10_000);

            const error = await observed;
            expect(error).toMatchObject({
                code: 'pending_queue_materialization_transport_ambiguous',
                diagnosticCode: 'pending_queue_materialization_ack_timeout',
                classification: 'ack_timeout',
            });
            expect(serializeOutboundError(error)).toMatchObject({
                code: 'pending_queue_materialization_transport_ambiguous',
                cause: {
                    code: 'socket_ack_timeout',
                    message: 'pending-materialize-next ack timed out after 10000ms',
                },
            });
            expect(mockPost).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('parses row-first provider delivery materialization with a durable transcript row', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'row-first-local',
                didWriteMessage: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first',
                    seq: 42,
                    localId: 'row-first-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first prompt' },
                            localId: 'row-first-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'row-first-local',
            didWrite: true,
            message: {
                id: 'm-row-first',
                seq: 42,
                localId: 'row-first-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'row-first prompt' },
                        localId: 'row-first-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('parses row-first provider delivery materialization from socket ACKs', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'row-first-socket-local',
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first-socket',
                    seq: 43,
                    localId: 'row-first-socket-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first socket prompt' },
                            localId: 'row-first-socket-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'row-first-socket-local',
            didWrite: true,
            message: {
                id: 'm-row-first-socket',
                seq: 43,
                localId: 'row-first-socket-local',
                deliveryState,
            },
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('parses provider delivery claims that are not committed transcript rows yet', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: null,
                    seq: null,
                    localId: 'claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'claimed prompt' },
                            localId: 'claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'claimed-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'claimed prompt' },
                        localId: 'claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows legacy provider delivery claims without explicit delivery state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'legacy-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy claimed prompt' },
                            localId: 'legacy-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'legacy-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'legacy-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'legacy claimed prompt' },
                        localId: 'legacy-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with an opaque materialization id under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'opaque-id-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'opaque-pending-materialization-id',
                    seq: null,
                    localId: 'opaque-id-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'opaque id claimed prompt' },
                            localId: 'opaque-id-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'opaque-id-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-pending-materialization-id',
                seq: null,
                localId: 'opaque-id-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'opaque id claimed prompt' },
                        localId: 'opaque-id-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with stale resolved provider state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'resolved-state-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: false },
                message: {
                    id: 'opaque-resolved-state-materialization-id',
                    seq: null,
                    localId: 'resolved-state-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'resolved provider state claimed prompt' },
                            localId: 'resolved-state-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'resolved-state-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-resolved-state-materialization-id',
                seq: null,
                localId: 'resolved-state-claimed-local',
                deliveryState: { mode: 'provider', unresolved: false },
            },
        });
    });

    it('allows provider delivery claims whose local id is only present on the materialize ack', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'top-level-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: null,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'top-level local id claimed prompt' },
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'top-level-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'top-level local id claimed prompt' },
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('returns a fail-closed contract result when transcript identity is only null after parser normalization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'malformed-seq-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: 'not-a-seq',
                    localId: 'malformed-seq-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'malformed seq claimed prompt' },
                            localId: 'malformed-seq-claimed-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'malformed-seq-claimed-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('returns a fail-closed contract result without an explicit false write marker', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'missing-write-marker-local',
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'missing-write-marker-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'missing write marker prompt' },
                            localId: 'missing-write-marker-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'missing-write-marker-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('does not fall back on authentication failures', async () => {
        mockPost.mockRejectedValueOnce({ response: { status: 401 } });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            response: { status: 401 },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/materialize-next'),
            { deliveryState: 'provider' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('settles provider-accepted delivery only through the current session publisher socket', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 9,
                message: {
                    id: 'm-accepted',
                    seq: 43,
                    localId: 'local/with spaces',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted prompt' },
                            localId: 'local/with spaces',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'local/with spaces',
        })).resolves.toEqual({
            didResolve: true,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 9,
                pendingBlockedCount: 0,
            },
            message: {
                id: 'm-accepted',
                seq: 43,
                localId: 'local/with spaces',
                messageRole: 'user',
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'accepted prompt' },
                        localId: 'local/with spaces',
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_000,
                deliveryState: null,
            },
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-delivery-accepted-v1', {
            v: 1,
            sessionId: 'session-1',
            localId: 'local/with spaces',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves didResolve false for a successful no-op accepted delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: false,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'blocked-local',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            },
            message: null,
        });
    });

    it('preserves the exact committed message proof for a replayed accepted delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: false,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 11,
                message: {
                    id: 'm-replayed-accepted',
                    seq: 44,
                    localId: ' replayed-accepted ',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted prompt' },
                            localId: ' replayed-accepted ',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: ' replayed-accepted ',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 11,
            },
            message: {
                id: 'm-replayed-accepted',
                seq: 44,
                localId: ' replayed-accepted ',
                messageRole: 'user',
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'accepted prompt' },
                        localId: ' replayed-accepted ',
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_001,
                deliveryState: null,
            },
        });
    });

    it.each([
        { ok: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10 },
        { ok: true, didResolve: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10 },
        { ok: true, didResolve: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10, extra: true },
        { ok: false, error: 'transaction-unavailable' },
        {
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 10,
            message: {},
        },
        {
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 10,
            message: {
                id: 'm-wrong-local-id',
                seq: 43,
                localId: 'different-local-id',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'wrong row' } } },
                createdAt: 1_000,
                updatedAt: 1_000,
            },
        },
    ])('fails closed on a malformed accepted settlement acknowledgement %#', async (ack) => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue(ack),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'accepted-local',
        })).rejects.toMatchObject({
            code: 'pending_queue_accepted_settlement_ambiguous',
            classification: 'malformed_ack',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('normalizes the real Socket.IO accepted-settlement ACK timeout without a second transport', async () => {
        vi.useFakeTimers();
        vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '100');
        // Keep Socket.IO's real ACK/timer machinery; replace only its outbound network boundary.
        const manager = new Manager('http://127.0.0.1', { autoConnect: false, reconnection: false });
        const socket = manager.socket('/');
        const packetWrite = vi.spyOn(manager, '_packet').mockImplementation(() => {});
        socket.connected = true;
        try {
            const outcome = resolveAcceptedPendingQueueV2Delivery({
                socket,
                sessionId: 'session-1',
                localId: 'accepted-local',
            }).then(
                (value) => ({ status: 'resolved' as const, value }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            );
            expect(packetWrite).toHaveBeenCalledWith(expect.objectContaining({
                data: ['pending-delivery-accepted-v1', { v: 1, sessionId: 'session-1', localId: 'accepted-local' }],
            }));
            await vi.advanceTimersByTimeAsync(100);
            expect(await outcome).toMatchObject({
                status: 'rejected',
                error: {
                    code: 'socket_ack_timeout',
                    event: 'pending-delivery-accepted-v1',
                    retryable: true,
                    timeoutMs: 100,
                },
            });
            expect(mockPost).not.toHaveBeenCalled();
        } finally {
            socket.disconnect();
            packetWrite.mockRestore();
            vi.unstubAllEnvs();
            vi.useRealTimers();
        }
    });

    it('retains an untagged transport failure as ambiguous settlement evidence', async () => {
        const failure = new Error('publisher rejected the request');
        // Only the external socket boundary rejects; the accepted-settlement adapter remains real.
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockRejectedValue(failure),
            timeout: vi.fn().mockReturnThis(),
        } as unknown as Parameters<typeof resolveAcceptedPendingQueueV2Delivery>[0]['socket'];

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket,
            sessionId: 'session-1',
            localId: 'accepted-local',
        })).rejects.toMatchObject({
            code: 'pending_queue_accepted_settlement_ambiguous',
            classification: 'transport_failure',
            cause: failure,
        });
        expect(failure).not.toHaveProperty('retryable');
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('fails closed without HTTP fallback when the publisher socket is disconnected', async () => {
        const socket = { connected: false, emitWithAck: vi.fn() };
        const error = await resolveAcceptedPendingQueueV2Delivery({
            socket: socket as unknown as Parameters<typeof resolveAcceptedPendingQueueV2Delivery>[0]['socket'],
            sessionId: 'session-1',
            localId: 'accepted-local',
        }).catch((error: unknown) => error);
        expect(error).toMatchObject({
            code: 'socket_not_connected',
            event: 'pending-delivery-accepted-v1',
            retryable: true,
        });
        expect(isAcceptedPendingQueueV2DeliveryRetryableError(error)).toBe(true);
        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
    });

    it.each([
        new Error('untyped disconnected transport'),
        Object.assign(new Error('unqualified disconnected socket'), { code: 'socket_not_connected' }),
        Object.assign(new Error('explicitly nonretryable disconnected socket'), { code: 'socket_not_connected', retryable: false }),
        Object.assign(new Error('unrecognized transport code'), { code: 'other_socket_failure', retryable: true }),
    ])('does not widen accepted-settlement retry to an unqualified failure %#', (error) => {
        expect(isAcceptedPendingQueueV2DeliveryRetryableError(error)).toBe(false);
    });


    it('posts provider delivery block state to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 1,
                pendingVersion: 10,
            },
        });

        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local/with spaces',
            reason: 'payload_too_large',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 10,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local%2Fwith%20spaces/delivery/block'),
            { reason: 'payload_too_large' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('lists only queued provider-delivery local ids for close recovery', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'typed-provider', status: 'queued', deliveryState: 'delivering', deliveryStatus: { status: 'delivering' } },
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'regular-queued', status: 'queued', deliveryState: null },
                    { localId: 'provider-blocked', status: 'queued', deliveryState: 'blocked' },
                    { localId: 'discarded-provider', status: 'discarded' },
                    { localId: 'provider-2', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual(['typed-provider', 'provider-1', 'provider-2']);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('projects canonical per-row delivery statuses (terminal rows are absent)', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'typed-only', deliveryStatus: { status: 'queued' } },
                    { localId: 'delivering-1', status: 'queued', deliveryState: 'delivering', deliveryStatus: { status: 'delivering' } },
                    { localId: 'blocked-1', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'provider_acceptance_timeout' },
                    { localId: 'discarded-1', status: 'discarded', discardedReason: 'manual' },
                ],
            },
        });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual([
            { localId: 'typed-only', status: 'queued' },
            { localId: 'delivering-1', status: 'delivering' },
            { localId: 'blocked-1', status: 'blocked' },
            { localId: 'discarded-1', status: 'discarded' },
        ]);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('requires the exact queued user send-now row for inactive-session activation', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    {
                        localId: 'eligible',
                        messageRole: 'user',
                        requestedAction: { v: 1, kind: 'send_now' },
                        deliveryStatus: { status: 'queued' },
                    },
                    {
                        localId: 'claimed',
                        messageRole: 'user',
                        requestedAction: { v: 1, kind: 'send_now' },
                        deliveryStatus: { status: 'delivering' },
                    },
                ],
            },
        });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'eligible',
        })).resolves.toBe('eligible');

        mockGet.mockResolvedValueOnce({
            data: {
                pending: [{
                    localId: 'wrong-action',
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryStatus: { status: 'queued' },
                }],
            },
        });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'wrong-action',
        })).resolves.toBe('ineligible');

        mockGet.mockResolvedValueOnce({ data: { pending: [] } });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'resolved',
        })).resolves.toBe('missing');
    });

    it.each([
        ['missing pending projection', {}],
        ['non-array pending projection', { pending: null }],
        ['malformed pending row', { pending: [{ status: 'queued' }] }],
        ['missing delivery status fields', { pending: [{ localId: 'missing-status' }] }],
        ['unknown legacy delivery status', { pending: [{ localId: 'unknown-status', status: 'future' }] }],
        ['invalid typed delivery status', {
            pending: [{ localId: 'invalid-typed', deliveryStatus: { status: 'future' } }],
        }],
        ['duplicate local id with identical status', {
            pending: [
                { localId: 'duplicate-identical', status: 'queued', deliveryState: 'delivering' },
                { localId: 'duplicate-identical', status: 'queued', deliveryState: 'delivering' },
            ],
        }],
        ['conflicting duplicate row', {
            pending: [
                { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                { localId: 'duplicate', status: 'discarded' },
            ],
        }],
    ])('rejects a non-authoritative delivery-status snapshot: %s', async (_case, data) => {
        mockGet.mockResolvedValueOnce({ data });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session-1',
        })).rejects.toThrow('Invalid pending queue delivery status projection');
    });

    it.each([
        ['local-id reader', () => listPendingQueueV2LocalIdsFromServer({ token: 'token', sessionId: 'session-1' })],
        ['delivery-status reader', () => listPendingQueueV2DeliveryStatusesFromServer({ token: 'token', sessionId: 'session-1' })],
        ['provider-delivery reader', () => listPendingQueueV2ProviderDeliveryLocalIdsFromServer({ token: 'token', sessionId: 'session-1' })],
        ['blocked-delivery reader', () => readBlockedPendingQueueV2DeliveryByLocalIdFromServer({ token: 'token', sessionId: 'session-1', localId: 'target' })],
    ])('uses the same strict canonical projection parser for the %s', async (_case, readProjection) => {
        const invalidProjections = [
            {},
            { pending: [{ localId: 'malformed-without-status' }] },
            { pending: [{ localId: 'invalid-typed', status: 'queued', deliveryStatus: { status: 'future' } }] },
            {
                pending: [
                    { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        ];

        for (const data of invalidProjections) {
            mockGet.mockResolvedValueOnce({ data });
            await expect(readProjection()).rejects.toThrow('Invalid pending queue delivery status projection');
        }
    });

    it('reads blocked provider delivery state for a specific local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'other-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'payload_too_large' },
                    {
                        localId: 'blocked-local',
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'runtime_disposed_before_delivery',
                        deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
                    },
                    { localId: 'delivering-local', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'future-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason' },
                ],
            },
        });

        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
            localId: 'blocked-local',
        })).resolves.toEqual({
            localId: 'blocked-local',
            reason: 'runtime_disposed_before_delivery',
        });

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('takes the typed delivery status over persisted fields the server overrides', async () => {
        // Server `mapPendingMessageRow` reports a queued row whose requested action it cannot parse
        // as blocked `unsupported_action`, while the persisted fields still say queued.
        const malformedActionRow = {
            localId: 'malformed-action',
            messageRole: 'user',
            content: { t: 'encrypted', c: 'cipher' },
            requestedActionMalformed: true,
            status: 'queued',
            deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
            position: 0,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: 'account-1',
        };
        mockGet.mockResolvedValueOnce({ data: { pending: [malformedActionRow] } });

        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session-1',
            localId: 'malformed-action',
        })).resolves.toEqual({ localId: 'malformed-action', reason: 'unsupported_action' });
    });

    describe('on a session holding a row the app handed to an external terminal', () => {
        // The exact shape `GET /v2/sessions/:id/pending` sends (server `toPendingJson`) for a row
        // enqueued with `deliveryMode: 'external_handoff'`: persisted fields and typed status together.
        function serverPendingRow(overrides: Readonly<{
            localId: string;
            requestedAction?: Readonly<{ v: 1; kind: 'enqueue' | 'send_now' }>;
            deliveryState?: 'delivering' | 'external_handoff' | 'blocked';
            deliveryBlockedReason?: string;
            deliveryStatus: Readonly<Record<string, unknown>>;
        }>) {
            return {
                localId: overrides.localId,
                messageRole: 'user',
                content: { t: 'encrypted', c: `cipher-${overrides.localId}` },
                requestedAction: overrides.requestedAction ?? { v: 1, kind: 'enqueue' },
                status: 'queued',
                ...(overrides.deliveryState ? { deliveryState: overrides.deliveryState } : {}),
                ...(overrides.deliveryBlockedReason ? { deliveryBlockedReason: overrides.deliveryBlockedReason } : {}),
                deliveryStatus: overrides.deliveryStatus,
                position: 0,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                discardedAt: null,
                discardedReason: null,
                authorAccountId: 'account-1',
            };
        }

        const handoffRow = serverPendingRow({
            localId: 'handoff-local',
            requestedAction: { v: 1, kind: 'send_now' },
            deliveryState: 'external_handoff',
            deliveryStatus: { status: 'external_handoff' },
        });

        it('lists every pending local id', async () => {
            mockGet.mockResolvedValueOnce({
                data: {
                    pending: [
                        serverPendingRow({ localId: 'queued-local', deliveryStatus: { status: 'queued' } }),
                        handoffRow,
                    ],
                },
            });

            await expect(listPendingQueueV2LocalIdsFromServer({
                token: 'token',
                sessionId: 'session-1',
            })).resolves.toEqual(['queued-local', 'handoff-local']);
        });

        it('leaves handed-off and raw-queued malformed-action rows out of the actionable rows', async () => {
            mockGet.mockResolvedValueOnce({
                data: {
                    pending: [
                        handoffRow,
                        serverPendingRow({ localId: 'queued-local', deliveryStatus: { status: 'queued' } }),
                        serverPendingRow({
                            localId: 'delivering-local',
                            deliveryState: 'delivering',
                            deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' },
                        }),
                        serverPendingRow({
                            localId: 'blocked-local',
                            deliveryState: 'blocked',
                            deliveryBlockedReason: 'runtime_disposed_before_delivery',
                            deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
                        }),
                        { localId: 'legacy-queued-local', status: 'queued', deliveryState: null },
                        {
                            ...serverPendingRow({
                                localId: 'malformed-action-local',
                                deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
                            }),
                            requestedAction: undefined,
                            requestedActionMalformed: true,
                        },
                        {
                            ...serverPendingRow({
                                localId: 'persisted-blocked-malformed-action-local',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'unsupported_action',
                                deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
                            }),
                            requestedAction: undefined,
                            requestedActionMalformed: true,
                        },
                    ],
                },
            });

            await expect(listPendingQueueV2ActionableLocalIdsFromServer({
                token: 'token',
                sessionId: 'session-1',
            })).resolves.toEqual([
                'queued-local',
                'delivering-local',
                'blocked-local',
                'legacy-queued-local',
                'persisted-blocked-malformed-action-local',
            ]);
        });

        it('projects the external handoff status, including from persisted fields alone', async () => {
            mockGet.mockResolvedValueOnce({
                data: {
                    pending: [
                        handoffRow,
                        { localId: 'legacy-handoff-local', status: 'queued', deliveryState: 'external_handoff' },
                        serverPendingRow({
                            localId: 'delivering-local',
                            deliveryState: 'delivering',
                            deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' },
                        }),
                    ],
                },
            });

            await expect(listPendingQueueV2DeliveryStatusesFromServer({
                token: 'token',
                sessionId: 'session-1',
            })).resolves.toEqual([
                { localId: 'handoff-local', status: 'external_handoff' },
                { localId: 'legacy-handoff-local', status: 'external_handoff' },
                { localId: 'delivering-local', status: 'delivering' },
            ]);
        });

        it('leaves the handed-off row out of this runner\'s provider deliveries', async () => {
            mockGet.mockResolvedValueOnce({
                data: {
                    pending: [
                        handoffRow,
                        serverPendingRow({
                            localId: 'delivering-local',
                            deliveryState: 'delivering',
                            deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' },
                        }),
                    ],
                },
            });

            await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
                token: 'token',
                sessionId: 'session-1',
            })).resolves.toEqual(['delivering-local']);
        });

        it('reads a blocked row beside it and reports the handed-off row as not blocked', async () => {
            const pending = [
                handoffRow,
                serverPendingRow({
                    localId: 'blocked-local',
                    deliveryState: 'blocked',
                    deliveryBlockedReason: 'runtime_disposed_before_delivery',
                    deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
                }),
            ];
            mockGet.mockResolvedValueOnce({ data: { pending } });
            await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
                token: 'token',
                sessionId: 'session-1',
                localId: 'blocked-local',
            })).resolves.toEqual({ localId: 'blocked-local', reason: 'runtime_disposed_before_delivery' });

            mockGet.mockResolvedValueOnce({ data: { pending } });
            await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
                token: 'token',
                sessionId: 'session-1',
                localId: 'handoff-local',
            })).resolves.toBeNull();
        });

        it('activates a queued send-now row beside it but never the handed-off row', async () => {
            const pending = [
                handoffRow,
                serverPendingRow({
                    localId: 'send-now-local',
                    requestedAction: { v: 1, kind: 'send_now' },
                    deliveryStatus: { status: 'queued' },
                }),
            ];
            mockGet.mockResolvedValueOnce({ data: { pending } });
            await expect(readPendingQueueV2ActivationEligibilityFromServer({
                token: 'token', sessionId: 'session-1', requestId: 'send-now-local',
            })).resolves.toBe('eligible');

            mockGet.mockResolvedValueOnce({ data: { pending } });
            await expect(readPendingQueueV2ActivationEligibilityFromServer({
                token: 'token', sessionId: 'session-1', requestId: 'handoff-local',
            })).resolves.toBe('ineligible');
        });
    });

    it('posts explicit handled resolution to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 12,
            },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 12,
                pendingBlockedCount: 0,
            },
            transcriptMessage: null,
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local-1/delivery/handled'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('returns the committed transcript message as the handled resolution proof', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 13,
                message: {
                    id: 'message-9',
                    seq: 41,
                    localId: ' local-1 ',
                    content: { t: 'plain', v: 'hello' },
                    deliveryResolution: { v: 1, kind: 'manual_handled' },
                    createdAt: 1,
                    updatedAt: 2,
                },
            },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: ' local-1 ',
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 13 },
            transcriptMessage: {
                id: 'message-9',
                seq: 41,
                localId: ' local-1 ',
                deliveryResolution: { v: 1, kind: 'manual_handled' },
            },
        });
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/%20local-1%20/delivery/handled'),
            {},
            expect.any(Object),
        );
    });

    it.each([
        ['another local id', { id: 'message-9', seq: 41, localId: 'local-2', deliveryResolution: { v: 1, kind: 'manual_handled' } }],
        ['no manual resolution', { id: 'message-9', seq: 41, localId: 'local-1' }],
        ['a negative sequence', { id: 'message-9', seq: -1, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } }],
        ['a blank message id', { id: ' ', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } }],
    ])('treats a handled response whose message has %s as an unreadable response', async (_case, message) => {
        mockPost.mockResolvedValueOnce({
            data: { ok: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 13, message },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).rejects.toMatchObject({ code: 'invalid_response_shape' });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('returns a validated committed transcript message as resolved even without queue counts', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                message: { id: 'message-9', seq: 41, localId: 'local-1', deliveryResolution: { v: 1, kind: 'manual_handled' } },
            },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).resolves.toEqual({
            transcriptMessage: {
                id: 'message-9',
                seq: 41,
                localId: 'local-1',
                deliveryResolution: { v: 1, kind: 'manual_handled' },
            },
        });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['nothing but ok', { ok: true }],
        ['no pending count', { ok: true, pendingBlockedCount: 0, pendingVersion: 13 }],
        ['no blocked count', { ok: true, pendingCount: 2, pendingVersion: 13 }],
        ['no pending version', { ok: true, pendingCount: 2, pendingBlockedCount: 0 }],
        ['a negative pending count', { ok: true, pendingCount: -1, pendingBlockedCount: 0, pendingVersion: 13 }],
        ['a fractional blocked count', { ok: true, pendingCount: 2, pendingBlockedCount: 0.5, pendingVersion: 13 }],
        ['a string pending version', { ok: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: '13' }],
    ])('treats a handled response without a message and with %s as an unreadable response', async (_case, data) => {
        mockPost.mockResolvedValueOnce({ data });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).rejects.toMatchObject({ code: 'invalid_response_shape' });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('marks unreadable delivery-action success bodies with the invalid-response code', async () => {
        mockPost.mockResolvedValueOnce({ data: 'not-json' });
        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token', sessionId: 'session-1', localId: 'local-1',
        })).rejects.toMatchObject({
            code: 'invalid_response_shape',
            message: 'Invalid pending delivery handled response',
        });

        mockPost.mockResolvedValueOnce({ data: { ok: false, error: 'internal' } });
        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token', sessionId: 'session-1', localId: 'local-1',
        })).rejects.toMatchObject({
            code: 'invalid_response_shape',
            message: 'Pending delivery handled failed: internal',
        });
    });

    it('keeps block settlement failures uncoded so their retry classification is unchanged', async () => {
        mockPost.mockResolvedValueOnce({ data: { ok: false, error: 'internal' } });

        const failure = await blockPendingQueueV2Delivery({
            token: 'token', sessionId: 'session-1', localId: 'local-1', reason: 'payload_too_large',
        }).then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Pending delivery block failed: internal');
        expect((failure as { code?: unknown }).code).toBeUndefined();
    });

    it('surfaces a handled transcript conflict with its HTTP status and server error after one POST', async () => {
        mockPost.mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 409, data: { error: 'transcript-conflict' } },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).rejects.toMatchObject({
            response: { status: 409, data: { error: 'transcript-conflict' } },
        });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('reads exact pending row snapshots, including external handoff rows and their positions', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    {
                        localId: 'blocked-1',
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'delivery_outcome_uncertain',
                        deliveryStatus: { status: 'blocked', reason: 'delivery_outcome_uncertain' },
                        position: 0,
                    },
                    {
                        localId: 'handoff-1',
                        status: 'queued',
                        deliveryState: 'external_handoff',
                        deliveryStatus: { status: 'external_handoff' },
                        position: 1,
                    },
                    {
                        localId: 'delivering-1',
                        status: 'queued',
                        deliveryState: 'delivering',
                        deliveryStatus: { status: 'delivering', detail: 'custody_observed' },
                        position: 2,
                    },
                    { localId: 'queued-1', status: 'queued', deliveryStatus: { status: 'queued' }, position: 3 },
                    {
                        localId: 'future-1',
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'future_reason',
                        deliveryStatus: { status: 'blocked', reason: 'unknown' },
                        position: 4,
                    },
                ],
            },
        });

        await expect(readPendingQueueV2RowSnapshotsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual([
            { localId: 'blocked-1', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain', position: 0 },
            { localId: 'handoff-1', status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null, position: 1 },
            { localId: 'delivering-1', status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, position: 2 },
            { localId: 'queued-1', status: 'queued', deliveryState: null, deliveryBlockedReason: null, position: 3 },
            { localId: 'future-1', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason', position: 4 },
        ]);
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('reads the server projection of an unreadable requested action with the persisted fields unchanged', async () => {
        // mapPendingMessageRow reports a non-discarded row whose stored requested action it cannot
        // parse as blocked `unsupported_action` in the typed status, while the persisted fields
        // keep what is stored.
        const unsupportedAction = { status: 'blocked', reason: 'unsupported_action' };
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    {
                        localId: 'queued-malformed',
                        requestedActionMalformed: true,
                        status: 'queued',
                        deliveryStatus: unsupportedAction,
                        position: 0,
                        discardedReason: null,
                    },
                    {
                        localId: 'blocked-malformed',
                        requestedActionMalformed: true,
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'future_reason',
                        deliveryStatus: unsupportedAction,
                        position: 1,
                        discardedReason: null,
                    },
                    {
                        localId: 'delivering-malformed',
                        requestedActionMalformed: true,
                        status: 'queued',
                        deliveryState: 'delivering',
                        deliveryStatus: unsupportedAction,
                        position: 2,
                        discardedReason: null,
                    },
                    {
                        localId: 'discarded-malformed',
                        requestedActionMalformed: true,
                        status: 'discarded',
                        deliveryStatus: { status: 'discarded', reason: 'user_discarded' },
                        position: 3,
                        discardedReason: 'user_discarded',
                    },
                ],
            },
        });

        await expect(readPendingQueueV2RowSnapshotsFromServer({
            token: 'token',
            sessionId: 'session-1',
        })).resolves.toEqual([
            { localId: 'queued-malformed', status: 'queued', deliveryState: null, deliveryBlockedReason: null, position: 0 },
            { localId: 'blocked-malformed', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason', position: 1 },
            { localId: 'delivering-malformed', status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, position: 2 },
            { localId: 'discarded-malformed', status: 'discarded', deliveryState: null, deliveryBlockedReason: null, position: 3 },
        ]);
    });

    it.each([
        ['missing pending list', {}],
        ['blank local id', { pending: [{ localId: ' ', status: 'queued', position: 0 }] }],
        ['missing position', { pending: [{ localId: 'a', status: 'queued' }] }],
        ['unknown row status', { pending: [{ localId: 'a', status: 'future', position: 0 }] }],
        ['unknown delivery state', { pending: [{ localId: 'a', status: 'queued', deliveryState: 'future', position: 0 }] }],
        ['blocked reason without blocked state', {
            pending: [{ localId: 'a', status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: 'unknown', position: 0 }],
        }],
        ['a typed status the protocol cannot read', {
            pending: [{
                localId: 'a', status: 'queued', deliveryState: 'external_handoff', deliveryStatus: { status: 'future' }, position: 0,
            }],
        }],
        ['no typed status and persisted fields that are not a persisted status', {
            pending: [{ localId: 'a', status: 'queued', deliveryState: 'blocked', discardedReason: 'resent_as_new', position: 0 }],
        }],
        ['duplicate local id', {
            pending: [
                { localId: 'a', status: 'queued', deliveryState: 'blocked', position: 0 },
                { localId: 'a', status: 'queued', deliveryState: 'blocked', position: 1 },
            ],
        }],
    ])('rejects a pending row snapshot with %s', async (_case, data) => {
        mockGet.mockResolvedValueOnce({ data });

        await expect(readPendingQueueV2RowSnapshotsFromServer({
            token: 'token',
            sessionId: 'session-1',
        })).rejects.toMatchObject({ code: 'invalid_response_shape' });
    });
});
