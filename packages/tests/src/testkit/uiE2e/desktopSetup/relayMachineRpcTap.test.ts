import { describe, expect, it } from 'vitest';

import { RELAY_FORWARD_TIMEOUT_ACK, buildAckFrame, parseAckFrame, parseRpcCallFrame } from './relayMachineRpcTap';

/**
 * Frames as socket.io-client 4 writes them for `emitWithAck('rpc-call', …)` and as the relay's
 * acknowledgement comes back (engine.io message `4`, socket.io EVENT `2` / ACK `3`, ack id, JSON).
 */
describe('relay machine RPC tap frames', () => {
    it('reads the method and ack id of an rpc-call, on the default and on a named namespace', () => {
        expect(parseRpcCallFrame('4217["rpc-call",{"method":"m-1:capabilities.describe","params":"AAAA"}]'))
            .toEqual({ ackId: '17', method: 'm-1:capabilities.describe' });
        expect(parseRpcCallFrame('42/ns,3["rpc-call",{"method":"m-1:x"}]')).toEqual({ ackId: '3', method: 'm-1:x' });
    });

    it('ignores other events, events without an ack id, and acks', () => {
        expect(parseRpcCallFrame('4217["ephemeral",{"method":"m-1:x"}]')).toBeNull();
        expect(parseRpcCallFrame('42["rpc-call",{"method":"m-1:x"}]')).toBeNull();
        expect(parseRpcCallFrame('4317[{"ok":true}]')).toBeNull();
        expect(parseRpcCallFrame('2')).toBeNull();
    });

    it('round-trips the injected acknowledgement through the ack parser', () => {
        expect(parseAckFrame(buildAckFrame('17', RELAY_FORWARD_TIMEOUT_ACK))).toEqual({ ackId: '17', ack: RELAY_FORWARD_TIMEOUT_ACK });
        expect(parseAckFrame('4317[{"ok":true,"result":"enc"}]')).toEqual({ ackId: '17', ack: { ok: true, result: 'enc' } });
    });
});
