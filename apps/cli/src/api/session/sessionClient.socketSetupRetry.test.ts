import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { MaterializeNextPendingResult } from './sessionClientPort';
import type { SessionMutationOutbox } from './mutations/createSessionMutationOutbox';
import { logger } from '@/ui/logger';

const offlineBoundary = vi.hoisted(() => {
  vi.stubEnv('HAPPIER_LOG_LEVEL', 'info');
  vi.stubEnv('DEBUG', '');
  const origin = 'https://relay.example.invalid';
  for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
    vi.stubEnv(key, origin);
  }
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || url.pathname !== '/v1/features') {
      throw new Error(`Unconfigured offline fetch: ${url.href}`);
    }
    return new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
        },
      },
    }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return { origin, fetch };
});

vi.mock('axios', async () => {
  const { createOfflineAxios } = await import('@/testkit/http/offlineAxios');
  return { default: {
    ...createOfflineAxios(async (url) => {
      throw new Error(`Unconfigured offline GET: ${url}`);
    }),
    isAxiosError: (payload: unknown) => payload !== null && typeof payload === 'object'
      && 'isAxiosError' in payload && payload.isAxiosError === true,
  } };
});

vi.mock('socket.io-client', () => ({
  io: () => { throw new Error('Unconfigured offline socket'); },
}));

const clients: import('./sessionClient').ApiSessionClient[] = [];
let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const readCredentialsMock = vi.hoisted(() => vi.fn());
const cacheWritingSettingsRefreshMock = vi.hoisted(() => vi.fn());

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
  };
});

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: (...args: unknown[]) => cacheWritingSettingsRefreshMock(...args),
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
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

// The Runtime Activity tail gates connection setup on publisher-fenced servers. While
// `setupTailBlocked` is set, setup observes an unsettled tail whose wait ends without a change,
// which is exactly the path where setup returns false on a still-connected socket.
let setupTailBlocked = false;
let setupTailBlockedUntilReleased = false;
let unsettledSetupTailWaits = 0;
// While set, the tail stays unsettled and its wait ends only when its signal aborts, as the real
// outbox wait does: setup then waits until close (or a disconnect) aborts the readiness controller.
let setupTailHeldUntilAbort = false;
let heldTailWaits = 0;
let heldTailAborts = 0;
let contractWrites = 0;
const settledTail = {
  sequence: 1,
  custody: null,
  settlement: {
    identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 1 },
    desiredValue: { state: 'idle', activeCount: 0 },
    result: 'applied',
    committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 },
    committedRevision: 1,
  },
};

vi.mock('./mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: (): SessionMutationOutbox => ({
    enqueueSessionTurn: async () => {},
    enqueueTranscriptMessage: async () => ({ persisted: true, delivered: true }),
    enqueueRuntimeActivitySnapshot: async () => ({ persisted: true, delivered: true }),
    setSessionSyncPendingInputServerContract: async () => { contractWrites += 1; },
    readRuntimeActivitySnapshotTail: () => (setupTailBlocked || setupTailBlockedUntilReleased || setupTailHeldUntilAbort
      ? { sequence: 1, custody: { mutationKey: 'runtime-activity-snapshot:s1' }, settlement: null }
      : settledTail) as any,
    waitForRuntimeActivitySnapshotTailChange: async (_sequence: number, signal?: AbortSignal) => {
      if (setupTailHeldUntilAbort) {
        heldTailWaits += 1;
        return await new Promise<boolean>((resolve) => {
          const onAbort = () => {
            heldTailAborts += 1;
            resolve(false);
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (setupTailBlocked || setupTailBlockedUntilReleased) unsettledSetupTailWaits += 1;
      setupTailBlocked = false;
      return false;
    },
    awaitReady: async () => {},
    flush: async () => {},
    close: async () => {},
  } as unknown as SessionMutationOutbox),
}));

let supervisorConnectedPromise: Promise<void> | null = null;

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      supervisorConnectedPromise = Promise.resolve(params.onConnected?.());
      await supervisorConnectedPromise;
    },
    stop: async () => {},
    getState: () => ({ phase: 'online' }),
    reportProbeResult: vi.fn(),
  }),
}));

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: async () => {},
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();
let sessionClientModulePromise: Promise<typeof import('./sessionClient')> | null = null;

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
    resolveAcceptedPendingQueueV2Delivery: async () => ({ didResolve: true }),
    blockPendingQueueV2Delivery: async () => ({}),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: async () => [],
    listPendingQueueV2DeliveryStatusesFromServer: async () => [],
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: (...args: unknown[]) => fetchSnapshotMock(...args),
  };
});

async function createClient(
  sessionOverrides: Record<string, unknown>,
  options: Readonly<{ awaitConnected?: boolean }> = {},
) {
  sessionSocketStub = createApiSessionSocketStub({
    id: 'session-socket',
    connected: true,
    emitWithAck: (event) => (event === 'ping' ? { v: 1 } : { ok: true }),
  });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('./sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const fixture = createPlainSessionFixture({ id: 's1' });
  const client = new ApiSessionClient('tok', {
    ...fixture,
    ...sessionOverrides,
    metadata: { ...fixture.metadata, machineId: 'machine-1' },
  } as any);
  clients.push(client);
  (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
  if (options.awaitConnected !== false) await supervisorConnectedPromise;
  return client;
}

describe('ApiSessionClient session socket setup retry', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('./sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
      vi.stubEnv(key, offlineBoundary.origin);
    }
    vi.stubGlobal('fetch', offlineBoundary.fetch);
    setupTailBlocked = false;
    setupTailBlockedUntilReleased = false;
    unsettledSetupTailWaits = 0;
    setupTailHeldUntilAbort = false;
    heldTailWaits = 0;
    heldTailAborts = 0;
    contractWrites = 0;
    supervisorConnectedPromise = null;
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue({
      token: 'tok',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    });
    cacheWritingSettingsRefreshMock.mockReset();
    cacheWritingSettingsRefreshMock.mockResolvedValue({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 0,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries setup that returned false on a connected socket and materializes without an external wake', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile');
    setupTailBlocked = true;
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        didWrite: true,
        localId: 'local-after-setup-retry',
        message: {
          seq: 10,
          localId: 'local-after-setup-retry',
          messageRole: 'user',
          content: { role: 'user', content: { type: 'text', text: 'queued before setup completed' } },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      })
      .mockResolvedValue({
        didMaterialize: false,
        localId: null,
        didWrite: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      });
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 });
    // The connection's first setup attempt returned false: its Runtime Activity wait ended unsettled.
    expect(unsettledSetupTailWaits).toBe(1);

    const results: MaterializeNextPendingResult[] = [];
    const materialize = client.materializeNextPendingMessageSafely.bind(client);
    const controller = new AbortController();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely: async (opts) => {
          const result = await materialize(opts);
          results.push(result);
          return result;
        },
        // No external wake source: only the client's own eligibility wake may restart the pass.
        waitForPendingEligibilityUpdate: (signal) => client.waitForPendingEligibilityUpdate(signal),
      },
    });
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });

    await vi.waitFor(() => expect(materializeNextMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect((client as any).sessionSyncPendingInputServerContract).toMatchObject({
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 1,
    });
    await vi.waitFor(() => expect(results).toContainEqual(expect.objectContaining({
      type: 'materialized',
      localId: 'local-after-setup-retry',
      seq: 10,
    })));
    expect(infoFile).toHaveBeenCalledWith(
      '[API] session socket setup did not complete',
      expect.objectContaining({ sessionId: 's1', connectionEpoch: 1, trigger: 'connect', failedAttempts: 1 }),
    );

    controller.abort();
    await expect(waiting).resolves.toBeNull();
  }, 20_000);

  it('lets a pending-input pass start setup again instead of only returning retryable transport', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile');
    setupTailBlockedUntilReleased = true;
    const clientPromise = createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 });
    // Connect-time attempts fail at 0, 0.25, 0.75 and 1.75 s; the next one is due 2 s later.
    await vi.waitFor(() => expect(unsettledSetupTailWaits).toBe(4), { timeout: 5_000 });
    const connectFailures = () => infoFile.mock.calls.filter((call) => (
      call[0] === '[API] session socket setup did not complete'
      && (call[1] as { trigger?: string }).trigger === 'connect'
    )).length;
    await vi.waitFor(() => expect(connectFailures()).toBe(4));
    const client = clients.at(-1)!;
    expect((client as any).sessionSyncPendingInputServerContract).toBeNull();

    setupTailBlockedUntilReleased = false;
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'retryable_transport' });
    await vi.waitFor(() => expect((client as any).sessionSyncPendingInputServerContract).toMatchObject({
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 1,
    }), { timeout: 1_000 });
    // The pending-input pass, not the connect-time retry, completed setup.
    expect(connectFailures()).toBe(4);
    expect(unsettledSetupTailWaits).toBe(4);
    await clientPromise;
  }, 20_000);

  it('starts no new setup after close begins, even while a close drain is still pending', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile');
    setupTailHeldUntilAbort = true;
    const client = await createClient(
      { latestTurnStatus: 'completed', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
      { awaitConnected: false },
    );
    await vi.waitFor(() => expect(heldTailWaits).toBe(1), { timeout: 5_000 });
    const contractWritesBeforeClose = contractWrites;
    let releaseDrain: () => void = () => {};
    const drainPending = new Promise<void>((resolve) => { releaseDrain = resolve; });
    vi.spyOn(client as any, 'drainBestEffortSessionWrites').mockImplementation(async () => await drainPending);

    const closing = client.close();
    try {
    // Close aborts   the readiness wait, so this connection's setup attempt returns false.
      await vi.waitFor(() => expect(heldTailAborts).toBe(1));
      // Hold close open well past the first retry delay (250 ms).
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(heldTailWaits).toBe(1);
      expect(contractWrites).toBe(contractWritesBeforeClose);
      expect(infoFile).not.toHaveBeenCalledWith(
        '[API] session socket setup did not complete',
        expect.objectContaining({ trigger: 'connect' }),
      );
      // A pending-input pass during close starts no setup either.
      await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heldTailWaits).toBe(1);
    expect(contractWrites).toBe(contractWritesBeforeClose);
    } finally {
      releaseDrain();
      await closing;
      clients.splice(clients.indexOf(client), 1);
    }
  }, 20_000);

  it('wakes the input consumer when a materialize answer adopts newer queue state', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 });
    await vi.waitFor(() => expect((client as any).sessionSyncPendingInputServerContract?.mode)
      .toBe('session_sync_v2_pending_input_v1'));
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: false,
        localId: null,
        didWrite: false,
        deferredReason: 'pending_version_mismatch',
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      })
      .mockResolvedValue({
        didMaterialize: false,
        localId: null,
        didWrite: false,
        deferredReason: 'waiting_for_predecessor',
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      });
    const controller = new AbortController();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely: (opts) => client.materializeNextPendingMessageSafely(opts),
        waitForPendingEligibilityUpdate: (signal) => client.waitForPendingEligibilityUpdate(signal),
      },
    });
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });

    // The second pass uses the adopted version; the matching broadcast never arrives.
    await vi.waitFor(() => expect(materializeNextMock).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(materializeNextMock.mock.calls[1]?.[0]).toMatchObject({ expectedPendingVersion: 2 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(materializeNextMock).toHaveBeenCalledTimes(2);

    controller.abort();
    await expect(waiting).resolves.toBeNull();
  }, 20_000);

  it('leaves unrelated waits alone: a materialize answer with unchanged state emits no wake', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 });
    await vi.waitFor(() => expect((client as any).sessionSyncPendingInputServerContract?.mode)
      .toBe('session_sync_v2_pending_input_v1'));
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
      deferredReason: 'waiting_for_predecessor',
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });
    const controller = new AbortController();
    const wake = client.waitForPendingEligibilityUpdate(controller.signal);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'deferred', reason: 'waiting_for_predecessor' });
    const settled = await Promise.race([wake, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))]);
    expect(settled).toBe('pending');
    controller.abort();
  });
});
