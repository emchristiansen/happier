import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { readRpcRequestDisposition } from './rpcRequestDisposition';

let nextRpcAck: any = null;
let nextConnectError: Error | null = null;
let nextEmitError: Error | null = null;
let nextEmitNeverAcks = false;
let nextDisconnectAfterConnect = false;
const createdSockets: FakeSocket[] = [];

class FakeSocket {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  public emitted: Array<{ event: string; data: any }> = [];
  public disconnectCalls = 0;
  public closeCalls = 0;
  public disconnectAfterConnect = false;

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((candidate) => candidate !== handler));
    return this;
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.length ?? 0;
  }

  trigger(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  connect() {
    if (nextConnectError) {
      for (const handler of this.handlers.get('connect_error') ?? []) {
        handler(nextConnectError);
      }
      return this;
    }
    for (const handler of this.handlers.get('connect') ?? []) {
      handler();
    }
    if (this.disconnectAfterConnect) {
      this.trigger('disconnect', 'transport close');
    }
    return this;
  }

  emit(event: string, data: any, callback: (payload: any) => void) {
    if (nextEmitError) {
      throw nextEmitError;
    }
    this.emitted.push({ event, data });
    if (nextEmitNeverAcks) return this;
    callback(nextRpcAck ?? { ok: true, result: { echoed: data.params } });
    return this;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }
}

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: vi.fn(() => {
    const socket = new FakeSocket();
    socket.disconnectAfterConnect = nextDisconnectAfterConnect;
    createdSockets.push(socket);
    return socket;
  }),
}));

describe('callSessionRpc (plaintext sessions)', () => {
  beforeEach(() => {
    nextRpcAck = null;
    nextConnectError = null;
    nextEmitError = null;
    nextEmitNeverAcks = false;
    nextDisconnectAfterConnect = false;
    createdSockets.length = 0;
    vi.useRealTimers();
  });

  it('sends plaintext params and returns plaintext results when mode=plain', async () => {
    const { callSessionRpc } = await import('./sessionRpc');
    const req = { a: 1 };
    const res = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: req,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    expect(res).toEqual({ echoed: req });
    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('connect')).toBe(0);
    expect(createdSockets[0]?.listenerCount('connect_error')).toBe(0);
    expect(createdSockets[0]?.listenerCount('disconnect')).toBe(0);
  });

  it('forwards an explicit transport timeout to the server', async () => {
    const { callSessionRpc } = await import('./sessionRpc');
    await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1', timeoutMs: null },
      timeoutMs: 86_400_000,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    expect(createdSockets[0]?.emitted[0]?.data).toMatchObject({
      method: 'sess_1:execution.run.wait',
      timeoutMs: 86_400_000,
      requestId: expect.any(String),
    });
  });

  it('throws RpcError with rpcErrorCode when the RPC response includes errorCode', async () => {
    nextRpcAck = {
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };

    const { callSessionRpc } = await import('./sessionRpc');
    await expect(
      callSessionRpc({
        token: 't',
        sessionId: 'sess_1',
        mode: 'plain',
        method: 'sess_1:demo.method',
        request: { a: 1 },
        ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
      }),
    ).rejects.toSatisfy((error: unknown) => readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('connect')).toBe(0);
    expect(createdSockets[0]?.listenerCount('connect_error')).toBe(0);
  });

  it('closes the one-shot socket when connect fails', async () => {
    nextConnectError = new Error('connect rejected');
    const { callSessionRpc } = await import('./sessionRpc');

    const error = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'connect rejected' });
    expect(readRpcRequestDisposition(error)).toBe('notSent');

    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('connect')).toBe(0);
    expect(createdSockets[0]?.listenerCount('connect_error')).toBe(0);
  });

  it('closes the one-shot socket when emit throws', async () => {
    nextEmitError = new Error('emit exploded');
    const { callSessionRpc } = await import('./sessionRpc');

    const error = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'emit exploded' });
    expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');

    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('connect')).toBe(0);
    expect(createdSockets[0]?.listenerCount('connect_error')).toBe(0);
  });

  it('closes the one-shot socket when the RPC ack times out', async () => {
    vi.useFakeTimers();
    nextEmitNeverAcks = true;
    const { callSessionRpc } = await import('./sessionRpc');

    const result = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      timeoutMs: 5,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });
    const errorPromise = result.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    const error = await errorPromise;
    expect(error).toMatchObject({ message: 'RPC call timeout' });
    expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('connect')).toBe(0);
    expect(createdSockets[0]?.listenerCount('connect_error')).toBe(0);
  });

  it('settles a caller-lifecycle RPC when its socket disconnects before acknowledgement', async () => {
    nextEmitNeverAcks = true;
    const { callSessionRpc } = await import('./sessionRpc');
    const result = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    await vi.waitFor(() => {
      expect(createdSockets[0]?.emitted[0]?.event).toBe(SOCKET_RPC_EVENTS.CALL);
    });
    createdSockets[0]?.trigger('disconnect', 'transport close');
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
  });

  it('does not miss a disconnect that immediately follows connection', async () => {
    nextEmitNeverAcks = true;
    nextDisconnectAfterConnect = true;
    const { callSessionRpc } = await import('./sessionRpc');
    const notSettled = Symbol('not settled');
    let outcome: unknown = notSettled;
    const result = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });
    void result.then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );

    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(outcome).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readRpcRequestDisposition(outcome)).toBe('notSent');
    expect(createdSockets[0]?.emitted).toHaveLength(0);
    expect(createdSockets[0]?.disconnectCalls).toBe(1);
    expect(createdSockets[0]?.closeCalls).toBe(1);
    expect(createdSockets[0]?.listenerCount('disconnect')).toBe(0);
  });
});
