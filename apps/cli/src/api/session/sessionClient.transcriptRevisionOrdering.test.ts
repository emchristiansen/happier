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

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onConnected?: () => Promise<void> | void;
  }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

type CommitPayload = string | { t: 'plain'; v: unknown };
type CommitSessionMessage = (params: {
  message: CommitPayload;
  localId: string;
  sidechainId: string | null;
  requireCommit: boolean;
  requireWriteDisposition?: boolean;
  markAsUserMessage?: boolean;
}) => Promise<number | null>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function readMessagePayloads(socket: ApiSessionSocketStub): CommitPayload[] {
  return socket.emitWithAck.mock.calls
    .filter((call) => call[0] === 'message')
    .map((call) => (call[1] as { message: CommitPayload }).message);
}

describe('ApiSessionClient transcript revision retry ordering', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HAPPIER_TRANSCRIPT_STORAGE;
  });

  it.each([
    { storage: 'persisted', required: false },
    { storage: 'persisted', required: true },
    { storage: 'direct', required: false },
    { storage: 'direct', required: true },
  ])('retains the exact $storage intent after temporary admission failure (required=$required)', async ({ storage, required }) => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = storage;
    const sent: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') return { ok: true };
        sent.push(payload);
        return sent.length === 1
          ? { ok: false, error: 'transaction-unavailable' }
          : { ok: true, id: 'existing-row', seq: 7, localId: 'original-id', didWrite: false };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
      pendingMaterializedLocalIds: Set<string>;
      lastObservedMessageSeq: number;
    };
    const first = internals.commitSessionMessage.call(client, {
      message: { t: 'plain', v: { role: 'assistant', content: 'original-body' } },
      localId: 'original-id', sidechainId: 'original-sidechain',
      requireCommit: required, requireWriteDisposition: required,
    });
    if (required) await expect(first).rejects.toThrow('transaction-unavailable');
    else await expect(first).resolves.toBeNull();
    expect(internals.sessionMessageCommitRetry.size).toBe(1);
    expect(internals.pendingMaterializedLocalIds.has('original-id')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(internals.lastObservedMessageSeq).toBe(7);
    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it.each([
    { storage: 'direct', caller: 'claude', invalidate: 'close' },
    { storage: 'persisted', caller: 'claude', invalidate: 'close' },
    { storage: 'direct', caller: 'agent', invalidate: 'close' },
    { storage: 'persisted', caller: 'agent', invalidate: 'close' },
    { storage: 'direct', caller: 'claude', invalidate: 'supersede' },
    { storage: 'persisted', caller: 'claude', invalidate: 'supersede' },
    { storage: 'direct', caller: 'agent', invalidate: 'supersede' },
    { storage: 'persisted', caller: 'agent', invalidate: 'supersede' },
  ])('rejects a late temporary $storage NACK for required $caller after $invalidate', async ({ storage, caller, invalidate }) => {
    // Storage is selected per client; reuse the module graph while each case creates and closes its own client.
    vi.useFakeTimers();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = storage;
    const firstAck = createDeferred<unknown>();
    const started = createDeferred<string>();
    const sent: { message: CommitPayload; localId: string }[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') return { ok: true };
        const message = payload as { message: CommitPayload; localId: string };
        sent.push(message);
        if (sent.length === 1) {
          started.resolve(message.localId);
          return firstAck.promise;
        }
        if (sent.length === 2) return { ok: false, error: 'transaction-unavailable' };
        return { ok: true, id: 'newer-row', seq: 7, localId: message.localId, didWrite: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const turnToken = client.beginTurnAssistantTextSnapshot({ turnToken: 'turn-1', startSeqExclusive: 0 });
    const state = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
      pendingMaterializedLocalIds: Set<string>;
      committedLocalIdsAwaitingEcho: Set<string>;
    };
    const required = caller === 'claude'
      ? client.sendClaudeSessionMessageCommittedExact({
        type: 'assistant', uuid: 'required-original',
        message: { role: 'assistant', content: [{ type: 'text', text: 'unconfirmed answer' }] },
      })
      : client.sendAgentMessageCommitted('codex', { type: 'message', message: 'unconfirmed answer' }, { localId: 'required-original' });
    // Observe rejection immediately, even while close drains the real required dispatch lane.
    const outcome = required.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const localId = await started.promise;
    let close: Promise<void> | undefined;
    if (invalidate === 'close') {
      close = client.close();
      expect(state.sessionMessageCommitRetry.size).toBe(0);
    } else {
      await state.commitSessionMessage.call(client, {
        message: 'newer-body', localId, sidechainId: null, requireCommit: false,
      });
      expect(state.sessionMessageCommitRetry.size).toBe(1);
    }
    firstAck.resolve({ ok: false, error: 'transaction-unavailable' });
    const result = await outcome;
    if (close) await close;
    expect(result).toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: expect.stringContaining('transaction-unavailable') }),
    });
    expect(client.getTurnAssistantTextSnapshot({ turnToken, startSeqExclusive: 0 })).toBeNull();
    expect(client.getLastObservedMessageSeq()).toBe(0);
    expect(state.committedLocalIdsAwaitingEcho.has(localId)).toBe(false);
    await vi.advanceTimersByTimeAsync(7_000);
    if (invalidate === 'close') {
      expect(sent).toHaveLength(1);
      expect(state.pendingMaterializedLocalIds.has(localId)).toBe(false);
    } else {
      expect(sent.map((message) => message.message)).toEqual([sent[0].message, 'newer-body', 'newer-body']);
      expect(client.getLastObservedMessageSeq()).toBe(7);
      await client.close();
    }
    expect(state.sessionMessageCommitRetry.size).toBe(0);
  });

  it.each(['direct', 'persisted'])('bounds temporary $storage admission retries without inventing a commit', async (storage) => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = storage;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event) => event === 'message'
        ? { ok: false, error: 'transaction-unavailable' }
        : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
      committedLocalIdsAwaitingEcho: Set<string>;
    };
    await internals.commitSessionMessage.call(client, {
      message: 'original-ciphertext', localId: 'original-id', sidechainId: null, requireCommit: false,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(readMessagePayloads(sessionSocketStub)).toEqual(Array(4).fill('original-ciphertext'));
    expect(internals.sessionMessageCommitRetry.size).toBe(0);
    expect(internals.committedLocalIdsAwaitingEcho.has('original-id')).toBe(false);
  });

  it.each(['direct', 'persisted'])('preserves $storage intent options through admission retry and reconnect', async (storage) => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = storage;
    const sent: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') return { ok: true };
        sent.push(payload);
        return sent.length === 1 ? { ok: false, error: 'transaction-unavailable' }
          : { ok: true, id: 'committed-row', seq: 7, localId: 'reconnect-original', didWrite: false };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const state = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      flushQueuedSessionMessagesOnReconnect(): Promise<void>;
    };
    await expect(state.commitSessionMessage.call(client, {
      message: 'original-ciphertext', localId: 'reconnect-original', sidechainId: 'sidechain',
      requireCommit: true, requireWriteDisposition: true, markAsUserMessage: true,
    })).rejects.toThrow('transaction-unavailable');
    sessionSocketStub.connected = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    sessionSocketStub.connected = true;
    await state.flushQueuedSessionMessagesOnReconnect();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(client.getCommittedUserMessageSeq('reconnect-original')).toBe(7);
  });

  it.each(['internal', 'forbidden', 'invalid-params'])('does not retry the permanent %s NACK', async (error) => {
    vi.resetModules();
    vi.useFakeTimers();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event) => event === 'message' ? { ok: false, error } : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const commit = (client as unknown as { commitSessionMessage: CommitSessionMessage }).commitSessionMessage.bind(client);
    await expect(commit({ message: 'body', localId: 'permanent-id', sidechainId: null, requireCommit: true })).rejects.toThrow(error);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(readMessagePayloads(sessionSocketStub)).toEqual(['body']);
  });

  it.each([
    {
      storageMode: 'plain',
      first: { t: 'plain' as const, v: { revision: 1 } },
      second: { t: 'plain' as const, v: { revision: 2 } },
    },
    {
      storageMode: 'e2ee-re-encrypted',
      first: 'ciphertext-for-revision-1',
      second: 'different-ciphertext-for-revision-2',
    },
  ])('never lets a delayed $storageMode retry overwrite a newer same-localId intent', async ({ first, second }) => {
    vi.resetModules();
    vi.useFakeTimers();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') return { ok: true };
        const attempt = readMessagePayloads(sessionSocketStub!).length;
        if (attempt <= 2) return null;
        return {
          ok: true,
          id: `message-${attempt}`,
          seq: attempt,
          localId: (payload as { localId: string }).localId,
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const commit = (client as unknown as { commitSessionMessage: CommitSessionMessage }).commitSessionMessage.bind(client);

    await commit({ message: first, localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await commit({ message: second, localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await vi.advanceTimersByTimeAsync(1_100);

    const sent = readMessagePayloads(sessionSocketStub);
    expect(sent).toEqual([first, second, second]);
  });

  it('does not let an older ACK clear the retry state for a newer generation', async () => {
    vi.resetModules();
    const firstAck = createDeferred<unknown>();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') return { ok: true };
        const message = (payload as { message: CommitPayload }).message;
        if (message === 'revision-1') return await firstAck.promise;
        return null;
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const commit = (client as unknown as { commitSessionMessage: CommitSessionMessage }).commitSessionMessage.bind(client);

    const firstCommit = commit({ message: 'revision-1', localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await Promise.resolve();
    const secondCommit = commit({ message: 'revision-2', localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    firstAck.resolve({ ok: true, id: 'old', seq: 1, localId: 'stable-tool-local-id' });
    await firstCommit;
    await secondCommit;

    const retryOwner = (client as unknown as { sessionMessageCommitRetry: { size: number } }).sessionMessageCommitRetry;
    expect(retryOwner.size).toBe(1);
  });

  it('cancels the current retry generation when transcript recovery materializes the localId', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      deleteMaterializedLocalId(localId: string): void;
      sessionMessageCommitRetry: { size: number };
    };
    await internals.commitSessionMessage.call(client, {
      message: 'revision-1',
      localId: 'recovered-local-id',
      sidechainId: null,
      requireCommit: false,
    });
    expect(internals.sessionMessageCommitRetry.size).toBe(1);

    internals.deleteMaterializedLocalId.call(client, 'recovered-local-id');

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('disposes retry timers before close begins asynchronous drain work', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const drain = createDeferred<void>();
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      drainBestEffortSessionWrites(): Promise<void>;
      sessionMessageCommitRetry: { size: number };
    };
    await internals.commitSessionMessage.call(client, {
      message: 'revision-1',
      localId: 'closing-local-id',
      sidechainId: null,
      requireCommit: false,
    });
    internals.drainBestEffortSessionWrites = async () => await drain.promise;

    const closePromise = client.close();
    await Promise.resolve();

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
    drain.resolve();
    await closePromise;
  });

  it('does not retain retry state when a required commit fails before any retry is scheduled', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: null });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
    };

    await expect(internals.commitSessionMessage.call(client, {
      message: 'required-revision',
      localId: 'disconnected-required-local-id',
      sidechainId: null,
      requireCommit: true,
    })).rejects.toThrow(/not connected/i);

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('clears retry state when an unconfirmed required direct commit throws without scheduling recovery', async () => {
    vi.resetModules();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
    };

    await expect(internals.commitSessionMessage.call(client, {
      message: 'required-revision',
      localId: 'unconfirmed-required-local-id',
      sidechainId: null,
      requireCommit: true,
    })).rejects.toThrow(/not confirmed/i);

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('does not resolve close() until pending best-effort transcript commits settle', async () => {
    vi.resetModules();
    const messageAck = createDeferred<{ ok: true; id: string; seq: number; localId: string }>();
    let messageCommitStarted = false;
    let messagePayload: any = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'message') {
          messageCommitStarted = true;
          messagePayload = payload;
          return await messageAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendSessionEvent({ type: 'ready' });
    await vi.waitFor(() => expect(messageCommitStarted).toBe(true));

    let didClose = false;
    const closePromise = client.close().then(() => {
      didClose = true;
    });

    for (let tick = 0; tick < 25; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(didClose).toBe(false);

    messageAck.resolve({ ok: true, id: 'm1', seq: 1, localId: messagePayload.localId });
    await closePromise;
    expect(didClose).toBe(true);
  });
});
