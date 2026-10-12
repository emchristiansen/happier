import { describe, expect, it } from 'vitest';

import {
  SOCKET_RPC_EVENTS,
  SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
  SocketRpcCancellationPayloadSchema,
  SocketRpcRequestIdSchema,
  SocketRpcTransportResponseEnvelopeV1Schema,
} from './socketRpc';

describe('socket RPC cancellation wire contract', () => {
  it('uses an additive cancel event with bounded opaque request correlations', () => {
    expect(SOCKET_RPC_EVENTS.CANCEL).toBe('rpc-cancel');
    expect(SocketRpcRequestIdSchema.parse(' request-1 ')).toBe('request-1');
    expect(SocketRpcCancellationPayloadSchema.parse({ requestId: 'request-1' })).toEqual({
      requestId: 'request-1',
    });
    expect(SocketRpcRequestIdSchema.safeParse('').success).toBe(false);
    expect(SocketRpcRequestIdSchema.safeParse('x'.repeat(161)).success).toBe(false);
    expect(SocketRpcCancellationPayloadSchema.safeParse({
      requestId: 'request-1',
      extra: true,
    }).success).toBe(false);
  });
});

describe('SocketRpcTransportResponseEnvelopeV1Schema', () => {
  it('accepts an opaque result with a strict stopped-session acknowledgement', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.parse({
      v: SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    })).toEqual({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    });
  });

  it('rejects unrecognized acknowledgement claims', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: { kind: 'session.stop', status: 'requested' },
    }).success).toBe(false);
  });

  it('requires the original result even when stopped proof is present', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      acknowledgement: { kind: 'session.stop', status: 'stopped' },
    }).success).toBe(false);
  });

  it('rejects unsupported envelope versions', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 2,
      result: 'opaque-encrypted-result',
    }).success).toBe(false);
  });

  it('rejects unknown envelope and acknowledgement fields', () => {
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      extra: true,
    }).success).toBe(false);
    expect(SocketRpcTransportResponseEnvelopeV1Schema.safeParse({
      v: 1,
      result: 'opaque-encrypted-result',
      acknowledgement: {
        kind: 'session.stop',
        status: 'stopped',
        extra: true,
      },
    }).success).toBe(false);
  });
});
