import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

const committed = (didResolve = true, localId = 'accepted-original') => ({
  ok: true, didResolve, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3,
  message: {
    id: 'committed-row', seq: 7, localId, messageRole: 'user',
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'accepted once' } } },
    createdAt: 1_000, updatedAt: 1_000,
  },
});

async function createAcceptedClient(responses: Array<unknown | (() => unknown)>) {
  vi.resetModules();
  vi.useFakeTimers();
  const sent: unknown[] = [];
  sessionSocketStub = createApiSessionSocketStub({
    connected: true,
    emitWithAck: async (event, payload) => {
      if (event !== 'pending-delivery-accepted-v1') return { ok: true };
      sent.push(payload);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response;
    },
  });
  userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
  const { ApiSessionClient } = await import('./sessionClient');
  const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
  // Seed the previously materialized claim. Acceptance still enters through the
  // production producer, and settlement uses the real transport, schemas and retry loop.
  const state = client as unknown as {
    canonicalPendingDeliveryByLocalId: Map<string, { state: { mode: 'provider'; unresolved: true } }>;
    hasMaterializationBlockingCanonicalPendingDelivery(): boolean;
    providerInputOutcomeProducerGeneration: number;
    sessionConnectionEpoch: number;
  };
  state.canonicalPendingDeliveryByLocalId.set('accepted-original', { state: { mode: 'provider', unresolved: true } });
  const observe = client.bindProviderInputOutcomeProducer({
    providerId: 'codex', mode: 'unifiedTerminal', matchesCurrentSession: () => true,
  });
  observe({ kind: 'accepted', localId: 'accepted-original' });
  await vi.advanceTimersByTimeAsync(0);
  return { client, state, sent, socket: sessionSocketStub };
}

describe('accepted settlement through real ACK transport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { kind: 'native Socket.IO timeout', response: new Error('operation has timed out') },
    { kind: 'untagged response loss', response: new Error('socket has been disconnected') },
    { kind: 'malformed response', response: { ok: true } },
    { kind: 'unavailable response', response: undefined },
    { kind: 'uncertain internal NACK', response: { ok: false, error: 'internal' } },
  ])('retries $kind with the same accepted identity without blocking later materialization', async ({ response }) => {
    const { client, state, sent } = await createAcceptedClient([response, committed()]);
    expect(client.hasPendingProviderInputAcceptance('accepted-original')).toBe(true);
    expect(state.hasMaterializationBlockingCanonicalPendingDelivery()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([
      { v: 1, sessionId: 's1', localId: 'accepted-original' },
      { v: 1, sessionId: 's1', localId: 'accepted-original' },
    ]);
    expect(client.hasCanonicalPendingProviderInputDelivery('accepted-original')).toBe(false);
    expect(state.hasMaterializationBlockingCanonicalPendingDelivery()).toBe(false);
    expect(client.getCommittedUserMessageSeq('accepted-original')).toBe(7);
  });

  it('continues rejoining a committed exact ID after repeated response loss without a reconnect', async () => {
    const { client, sent } = await createAcceptedClient([
      new Error('response lost after commit'), new Error('response lost again'), committed(false),
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(3);
    expect(sent.every((payload) => JSON.stringify(payload) === JSON.stringify(sent[0]))).toBe(true);
    expect(client.getCommittedUserMessageSeq('accepted-original')).toBe(7);
    expect(client.hasCanonicalPendingProviderInputDelivery('accepted-original')).toBe(false);
  });

  it.each(['forbidden', 'transcript-conflict', 'invalid-params'])('retains custody without retrying a definitive %s refusal', async (error) => {
    const { client, sent } = await createAcceptedClient([{ ok: false, error }, committed()]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    expect(client.hasCanonicalPendingProviderInputDelivery('accepted-original')).toBe(true);
    expect(client.hasPendingProviderInputAcceptance('accepted-original')).toBe(true);
  });

  it.each(['disconnect', 'producer', 'connection', 'termination'])(
    'stops retrying on %s authority loss while retaining accepted custody', async (loss) => {
      const { client, state, socket, sent } = await createAcceptedClient([new Error('response lost'), committed()]);
      if (loss === 'disconnect') socket.connected = false;
      if (loss === 'producer') state.providerInputOutcomeProducerGeneration += 1;
      if (loss === 'connection') state.sessionConnectionEpoch += 1;
      if (loss === 'termination') client.beginRuntimeTermination();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sent).toHaveLength(1);
      expect(client.hasPendingProviderInputAcceptance('accepted-original')).toBe(true);
      expect(client.hasCanonicalPendingProviderInputDelivery('accepted-original')).toBe(true);
    },
  );
});
