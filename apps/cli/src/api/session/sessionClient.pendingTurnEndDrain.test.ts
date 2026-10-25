import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'node:fs';

import { createDeferred } from '@/testkit/async/deferred';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { encodeBase64, encrypt } from '../encryption';
import { accountSettingsParse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { configuration } from '@/configuration';
import {
  getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SessionMutationOutbox } from './mutations/createSessionMutationOutbox';
import { logger } from '@/ui/logger';
import type { SessionProviderInputOutcomeObserver } from './sessionClient';
import { createCodexAppServerProviderInputOutcomeBridge } from '@/backends/codex/appServer/codexAppServerProviderInputOutcome';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSocketAckError } from '@/session/transport/shared/socketAck';
import {
  PendingQueueAcceptedSettlementError,
  PendingQueueMaterializationTransportAmbiguousError,
} from './pendingQueueV2Transport';

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
          pendingInputExactLocalId: { protocolVersion: 1 },
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
const providerInputOutcomeObservers = new WeakMap<object, SessionProviderInputOutcomeObserver>();

function providerInputOutcomeObserver(client: any) {
  let observe = providerInputOutcomeObservers.get(client);
  if (!observe) {
    observe = client.bindProviderInputOutcomeProducer({
      providerId: 'codex',
      mode: 'unifiedTerminal',
      matchesCurrentSession: () => true,
    });
    providerInputOutcomeObservers.set(client, observe!);
  }
  return observe!;
}

function confirmProviderInputAccepted(
  client: any,
  localId: string,
): void {
  if (localId.trim().length === 0) return;
  providerInputOutcomeObserver(client)({ kind: 'accepted', localId });
}

function hasProviderInputAcceptance(client: any, localId: string): boolean {
  return client.hasPendingProviderInputAcceptance(localId) === true;
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const accountSettingsCredentialsSecret = new Uint8Array(32).fill(7);
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

const enqueueSessionTurnMock = vi.fn(async (_mutation: unknown) => {});
const enqueueTranscriptMessageMock = vi.fn(async (_mutation: unknown) => ({ persisted: true, delivered: true }));
const flushOutboxMock = vi.fn(async (_reason: unknown) => {});
const closeOutboxMock = vi.fn(async () => {});
const setServerContractMock = vi.fn(async (_result: unknown) => {});

vi.mock('./mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: (): SessionMutationOutbox => ({
    enqueueSessionTurn: (mutation: { action?: unknown }) => enqueueSessionTurnMock(mutation),
    enqueueTranscriptMessage: (mutation: unknown) => enqueueTranscriptMessageMock(mutation),
    enqueueRuntimeActivitySnapshot: async () => ({ persisted: true, delivered: true }),
    setSessionSyncPendingInputServerContract: (result: unknown) => setServerContractMock(result),
    readRuntimeActivitySnapshotTail: () => ({
      sequence: 1,
      custody: null,
      settlement: {
        identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 1 },
        desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied',
        committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 },
        committedRevision: 1,
      },
    }),
    waitForRuntimeActivitySnapshotTailChange: async () => false,
    awaitReady: async () => {},
    flush: (reason: unknown) => flushOutboxMock(reason),
    close: () => closeOutboxMock(),
  }),
}));

let supervisorPhase = 'online';
let supervisorOnConnected: (() => Promise<void> | void) | null = null;
let supervisorConnectedPromise: Promise<void> | null = null;
const supervisorReportProbeResultMock = vi.fn();

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      supervisorOnConnected = params.onConnected ?? null;
      supervisorConnectedPromise = Promise.resolve(params.onConnected?.());
      await supervisorConnectedPromise;
    },
    stop: async () => {},
    getState: () => ({ phase: supervisorPhase }),
    reportProbeResult: supervisorReportProbeResultMock,
  }),
}));

const catchUpMock = vi.fn(async (_opts?: unknown) => {});

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: (opts: unknown) => catchUpMock(opts),
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();
const resolveAcceptedPendingDeliveryMock = vi.fn();
const blockPendingDeliveryMock = vi.fn();
const listProviderDeliveryLocalIdsMock = vi.fn();
const listDeliveryStatusesMock = vi.fn();
let sessionClientModulePromise: Promise<typeof import('./sessionClient')> | null = null;

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
    resolveAcceptedPendingQueueV2Delivery: (...args: unknown[]) => resolveAcceptedPendingDeliveryMock(...args),
    blockPendingQueueV2Delivery: (...args: unknown[]) => blockPendingDeliveryMock(...args),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: (...args: unknown[]) => listProviderDeliveryLocalIdsMock(...args),
    listPendingQueueV2DeliveryStatusesFromServer: (...args: unknown[]) => listDeliveryStatusesMock(...args),
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
  options: Readonly<{
    sessionSocketEmitWithAck?: NonNullable<Parameters<typeof createApiSessionSocketStub>[0]>['emitWithAck'];
    serverContractMode?: 'current' | 'released';
  }> = {},
) {
  const customEmitWithAck = options.sessionSocketEmitWithAck;
  sessionSocketStub = createApiSessionSocketStub({
    id: 'session-socket',
    connected: true,
    emitWithAck: (event, payload, socket) => {
      if (event === 'ping') {
        if (options.serverContractMode === 'released') return {};
        return { v: 1 };
      }
      return customEmitWithAck?.(event, payload, socket) ?? { ok: true };
    },
  });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('./sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const fixture = createPlainSessionFixture({ id: 's1' });
  const client = new ApiSessionClient('tok', {
    ...fixture,
    ...sessionOverrides,
    metadata: {
      ...fixture.metadata,
      machineId: 'machine-1',
      ...(sessionOverrides.metadata && typeof sessionOverrides.metadata === 'object'
        ? sessionOverrides.metadata
        : {}),
    },
  } as any);
  clients.push(client);
  (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
  await supervisorConnectedPromise;
  return client;
}

function triggerCommittedUserMessage(params: Readonly<{
  seq: number;
  localId: string;
  text?: string;
}>): void {
  if (!userSocketStub) throw new Error('Missing user socket stub');
  userSocketStub.trigger('update', {
    id: `update-${params.seq}`,
    createdAt: Date.now(),
    body: {
      t: 'new-message',
      sid: 's1',
      message: {
        id: `m${params.seq}`,
        seq: params.seq,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: params.text ?? `prompt ${params.seq}` },
            localId: params.localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        localId: params.localId,
        messageRole: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCurrentPendingInputContract(client: Awaited<ReturnType<typeof createClient>>): Promise<void> {
  await waitUntil(() => (
    (client as any).sessionSyncPendingInputServerContract?.mode === 'session_sync_v2_pending_input_v1'
  ));
}

type MaterializeOptionsWithDeliveryTiming =
  NonNullable<Parameters<Awaited<ReturnType<typeof createClient>>['materializeNextPendingMessageSafely']>[0]> & {
    pendingQueueDeliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
  };

function runtimeIdleMaterializeOptions(
  opts: MaterializeOptionsWithDeliveryTiming = {},
): MaterializeOptionsWithDeliveryTiming {
  return {
    reconcileWhenEmpty: 'force',
    pendingQueueDeliveryTiming: 'after_runtime_idle',
    ...opts,
  };
}

function createPendingDeliveryHttpError(
  status: number,
  error: string,
  opts: Readonly<{
    retryAfterMs?: number;
    correlationId?: string;
    retryAfterHeader?: string;
  }> = {},
): Error & {
  isAxiosError: true;
  response: {
    status: number;
    data: { error: string; retryAfterMs?: number; correlationId?: string };
    headers: Record<string, string>;
  };
} {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: true;
    response: {
      status: number;
      data: { error: string; retryAfterMs?: number; correlationId?: string };
      headers: Record<string, string>;
    };
  };
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.response = {
    status,
    data: {
      error,
      ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    },
    headers: opts.retryAfterHeader ? { 'retry-after': opts.retryAfterHeader } : {},
  };
  return err;
}

function createProviderDeliveryMaterializeResult(localId: string, pendingVersion = 2) {
  return {
    didMaterialize: true,
    localId,
    didWrite: false,
    pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion },
    message: {
      id: null,
      seq: null,
      localId,
      messageRole: 'user',
      deliveryState: { mode: 'provider' as const, unresolved: true },
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: `prompt ${localId}` },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
}

describe('ApiSessionClient pending-queue turn-end drain', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('./sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
      vi.stubEnv(key, offlineBoundary.origin);
    }
    vi.stubGlobal('fetch', offlineBoundary.fetch);
    supervisorOnConnected = null;
    supervisorConnectedPromise = null;
    supervisorReportProbeResultMock.mockReset();
    catchUpMock.mockReset();
    catchUpMock.mockResolvedValue(undefined);
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
    resolveAcceptedPendingDeliveryMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockResolvedValue({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    blockPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockResolvedValue({});
    listProviderDeliveryLocalIdsMock.mockReset();
    listProviderDeliveryLocalIdsMock.mockResolvedValue([]);
    listDeliveryStatusesMock.mockReset();
    listDeliveryStatusesMock.mockResolvedValue([]);
    enqueueSessionTurnMock.mockClear();
    enqueueTranscriptMessageMock.mockClear();
    flushOutboxMock.mockClear();
    closeOutboxMock.mockClear();
    setServerContractMock.mockClear();
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue({
      token: 'tok',
      encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
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
      const pending = client as unknown as {
        changesSyncInFlight: Promise<void> | null;
        userSocketSettingsConvergenceInFlight: Promise<void> | null;
        accountSettingsHintConvergenceInFlight: Promise<void> | null;
        accountSettingsRequestInFlight: Promise<boolean> | null;
      };
      const drains = [pending.changesSyncInFlight, pending.userSocketSettingsConvergenceInFlight,
        pending.accountSettingsHintConvergenceInFlight, pending.accountSettingsRequestInFlight];
      await client.close();
      await Promise.allSettled([...drains, pending.changesSyncInFlight,
        pending.userSocketSettingsConvergenceInFlight, pending.accountSettingsHintConvergenceInFlight,
        pending.accountSettingsRequestInFlight]);
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('blocks a contract-invalid provider action before invoking provider input', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'invalid-provider-action-local',
      didWrite: false,
      message: null,
      providerDeliveryContractInvalid: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });

    expect(delivered).toEqual([]);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'invalid-provider-action-local',
      reason: 'unsupported_action',
    });
  });

  it('uses one exact current contract result object for Runtime and Pending consumers', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const contract = (client as any).sessionSyncPendingInputServerContract;
    expect(contract).toEqual({
      mode: 'session_sync_v2_pending_input_v1',
      runtimeActivity: 'v2',
      pendingInput: 'v1',
      pendingExactLocalId: 'v1',
      sessionConnectionEpoch: 1,
      socket: sessionSocketStub,
    });
    expect(setServerContractMock).toHaveBeenCalledWith(contract);
    expect(setServerContractMock.mock.calls[0]?.[0]).toBe(contract);
    materializeNextMock.mockResolvedValueOnce({ didMaterialize: false, localId: null, didWrite: false });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('performs zero provider input when the current result object is replaced during materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));
    materializeNextMock.mockImplementationOnce(async () => {
      const current = (client as any).sessionSyncPendingInputServerContract;
      (client as any).sessionSyncPendingInputServerContract = { ...current };
      return {
        didMaterialize: true,
        localId: 'stale-current-local',
        didWrite: true,
        message: {
          id: 'stale-current-message',
          seq: 9,
          localId: 'stale-current-local',
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not deliver' } } },
          createdAt: 100,
          updatedAt: 101,
        },
      };
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'retryable_transport' });
    expect(delivered).toEqual([]);
  });

  it('does not report stale authentication after the current result object is replaced', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    materializeNextMock.mockImplementationOnce(async () => {
      const current = (client as any).sessionSyncPendingInputServerContract;
      (client as any).sessionSyncPendingInputServerContract = { ...current };
      throw createPendingDeliveryHttpError(401, 'unauthorized');
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'retryable_transport' });
  });

  it('selects only the released adapter from the identical old-server contract result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: { sharing: { pendingQueueV2: { enabled: true } } },
      capabilities: {},
    }), { status: 200 })));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (!String(url).includes('/messages/by-local-id/released-local-1')) {
        throw new Error(`Unexpected HTTP GET in released adapter test: ${String(url)}`);
      }
      return {
        status: 200,
        data: {
          message: {
            id: 'released-message-1',
            seq: 8,
            localId: 'released-local-1',
            sidechainId: null,
            createdAt: 100,
            updatedAt: 101,
            content: {
              t: 'plain',
              v: { role: 'user', content: { type: 'text', text: 'released prompt' } },
            },
          },
        },
      };
    });
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }, {
      serverContractMode: 'released',
      sessionSocketEmitWithAck: (event) => event === 'pending-materialize-next'
        ? {
          ok: true,
          didMaterialize: true,
          didWrite: true,
          message: { id: 'released-message-1', seq: 8, localId: 'released-local-1' },
        }
        : { ok: false },
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const contract = (client as any).sessionSyncPendingInputServerContract;
    expect(contract.mode).toBe('released_server_v0_2_1');
    expect(setServerContractMock.mock.calls[0]?.[0]).toBe(contract);
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({
        type: 'materialized',
        localId: 'released-local-1',
        seq: 8,
      });
    expect(materializeNextMock).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
  });

  it.each([
    ['indeterminate', new Response(JSON.stringify({ invalid: true }), { status: 200 }), { type: 'retryable_transport' }],
    ['auth_failed', new Response('', { status: 401 }), { type: 'auth_failure', statusCode: 401 }],
  ] as const)('performs zero provider input for %s contract evidence', async (_name, featureResponse, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(featureResponse));
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual(expected);
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('does not attempt materialization when every queued pending row is blocked', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 1,
      pendingVersion: 1,
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'skip',
    })).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });


  it('reports an active foreground turn as steerable when the caller owns in-flight steer', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'live-steer-local',
      didWrite: true,
      message: {
        id: 'm-live-steer',
        seq: 42,
        localId: 'live-steer-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
    });

    expect(materializeNextMock).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'materialized',
      localId: 'live-steer-local',
      seq: 42,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it('keeps default foreground-ready queued materialization eligible while runtime activity is active', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'foreground-ready-local',
      didWrite: true,
      message: {
        id: 'm-foreground-ready',
        seq: 43,
        localId: 'foreground-ready-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'queued prompt' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    } satisfies MaterializeOptionsWithDeliveryTiming)).resolves.toMatchObject({
      type: 'materialized',
      localId: 'foreground-ready-local',
    });
    expect(materializeNextMock).toHaveBeenCalled();
  });

  it('wakes runtime-idle delivery from the durable explicit idle revision exactly once', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 9_000,
      runtimeActivityRevision: 4,
    });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      deferredReason: 'waiting_for_runtime_activity',
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'deferred',
      reason: 'waiting_for_runtime_activity',
    });

    const wake = client.waitForMetadataUpdate();
    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'runtime-activity-snapshot-idle',
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        sid: 's1',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 10_000,
        runtimeActivityRevision: 5,
      },
    });

    await expect(wake).resolves.toBe(true);
    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(true);

    const duplicateWaitAbort = new AbortController();
    let duplicateWake: boolean | null = null;
    const duplicateWait = client.waitForMetadataUpdate(duplicateWaitAbort.signal).then((result) => {
      duplicateWake = result;
    });
    userSocketStub.trigger('update', {
      id: 'runtime-activity-snapshot-idle-duplicate',
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        sid: 's1',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 10_000,
        runtimeActivityRevision: 5,
      },
    });
    await Promise.resolve();
    expect(duplicateWake).toBeNull();
    duplicateWaitAbort.abort();
    await duplicateWait;
    expect(duplicateWake).toBe(false);
  });

  it('wakes after a locally applied timing change broadens ordinary eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    const snapshot = (timing: 'after_runtime_idle' | 'after_foreground_ready', version: number) => ({
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: timing }),
      settingsVersion: version,
      loadedAtMs: version,
      settingsSecretsReadKeys: [],
    });
    setActiveAccountSettingsSnapshot(snapshot('after_runtime_idle', 20));
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    const wake = client.waitForMetadataUpdate();

    setActiveAccountSettingsSnapshot(snapshot('after_foreground_ready', 21));

    await expect(wake).resolves.toBe(true);

    const reverseAbort = new AbortController();
    const reverseWake = client.waitForMetadataUpdate(reverseAbort.signal);
    setActiveAccountSettingsSnapshot(snapshot('after_runtime_idle', 22));
    await Promise.resolve();
    reverseAbort.abort();
    await expect(reverseWake).resolves.toBe(false);
    if (previous) setActiveAccountSettingsSnapshot(previous);
  });

  it('applies a user-scoped account settings update before publishing a following pending wake', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();

      userSocketStub.trigger('update', {
        id: 'account-settings-v1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: {
              t: 'encrypted',
              c: encodeBase64(encrypt(accountSettingsCredentialsSecret, 'legacy', {
                sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
              })),
            },
            version: 1,
          },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-settings-v1',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 1,
        settings: expect.objectContaining({
          sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
        }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('force-reconciles stale pending state before publishing an explicit materialization wake', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 0,
      pendingVersion: 0,
    });
    const snapshot = createDeferred<Record<string, unknown>>();
    fetchSnapshotMock.mockClear();
    fetchSnapshotMock.mockReturnValueOnce(snapshot.promise);
    const onWake = vi.fn();
    client.on('pending-eligibility-updated', onWake);

    client.wakePendingMaterialization();

    await vi.waitFor(() => expect(fetchSnapshotMock).toHaveBeenCalledTimes(1));
    expect(onWake).not.toHaveBeenCalled();

    snapshot.resolve({
      latestTurnStatus: 'completed',
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });

    await vi.waitFor(() => expect(onWake).toHaveBeenCalled());
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('still publishes an explicit materialization wake when forced reconciliation fails', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 0,
      pendingVersion: 0,
    });
    fetchSnapshotMock.mockClear();
    fetchSnapshotMock.mockRejectedValueOnce(new Error('snapshot unavailable'));
    const onWake = vi.fn();
    client.on('pending-eligibility-updated', onWake);

    client.wakePendingMaterialization();

    await vi.waitFor(() => expect(fetchSnapshotMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onWake).toHaveBeenCalled());
  });

  it('uses a strict request-only settings refresh for reconnect convergence without the cache-writing bootstrap owner', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      } as never);

      await (client as unknown as {
        refreshAccountSettingsFromChangesHint: (version: number | null) => Promise<void>;
      }).refreshAccountSettingsFromChangesHint(5);

      expect(cacheWritingSettingsRefreshMock).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/account\/settings$/),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 5 });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('converges settings on the real user-socket connect before resolving Pending eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      const response = createDeferred<{
        status: number;
        data: {
          content: { t: 'plain'; v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } };
          version: number;
        };
      }>();
      const get = vi.spyOn(axios, 'get').mockImplementationOnce(() => response.promise as never);
      let wakeResult: boolean | null = null;

      const wake = client.waitForPendingEligibilityUpdate();
      void wake.then((value) => {
        wakeResult = value;
      });
      await waitUntil(() => get.mock.calls.length === 1);

      expect(get).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/account\/settings$/),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      expect(wakeResult).toBeNull();

      response.resolve({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      });
      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('shares one settings convergence when the user and session sockets reconnect together', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      if (!userSocketStub || !sessionSocketStub || !supervisorOnConnected) {
        throw new Error('missing reconnect harness');
      }

      const settingsResponse = createDeferred<{
        status: number;
        data: {
          content: { t: 'plain'; v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } };
          version: number;
        };
      }>();
      const get = vi.spyOn(axios, 'get').mockImplementation((url) => {
        const path = String(url);
        if (new URL(path).origin !== offlineBoundary.origin) {
          throw new Error(`Offline HTTP boundary refused origin: ${new URL(path).origin}`);
        }
        if (path.endsWith('/v2/changes')) {
          return Promise.resolve({
            status: 200,
            data: { changes: [], nextCursor: 1 },
          }) as never;
        }
        if (path.endsWith('/v2/account/settings')) {
          return settingsResponse.promise as never;
        }
        throw new Error(`Unexpected reconnect GET: ${path}`);
      });

      userSocketStub.connected = false;
      userSocketStub.connect.mockImplementation(() => userSocketStub as never);
      const wake = client.waitForPendingEligibilityUpdate();
      let wakeResult: boolean | null = null;
      void wake.then((value) => {
        wakeResult = value;
      });

      const reconnect = Promise.resolve(supervisorOnConnected());
      await waitUntil(() => get.mock.calls.some(([url]) => String(url).endsWith('/v2/account/settings')));
      userSocketStub.connected = true;
      userSocketStub.trigger('connect');
      await Promise.resolve();

      expect(wakeResult).toBeNull();
      settingsResponse.resolve({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      });

      await reconnect;
      await expect(wake).resolves.toBe(true);
      expect(get.mock.calls.filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(1);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
      expect((client as unknown as {
        userSocketSettingsConnectionEpoch: number;
        userSocketSettingsConvergedEpoch: number;
      }).userSocketSettingsConvergedEpoch).toBe(
        (client as unknown as { userSocketSettingsConnectionEpoch: number }).userSocketSettingsConnectionEpoch,
      );
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it.each([
    {
      name: 'credential token differs from the session token',
      prepare: () => readCredentialsMock.mockResolvedValueOnce({
        token: 'different-token',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      }),
      accountId: 'account-1',
    },
    {
      name: 'payload account differs from the authenticated account',
      prepare: () => {},
      accountId: 'different-account',
    },
  ])('fails closed when live settings binding is invalid: $name', async ({ prepare, accountId }) => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      prepare();

      userSocketStub.trigger('update', {
        id: `binding-${accountId}`,
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: accountId,
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('invalidates an older in-flight live apply when a malformed successor arrives', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const credentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => credentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-valid-v1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.trigger('update', {
        id: 'settings-malformed-v2',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 2 },
        },
      });
      credentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await Promise.resolve();
      await waitUntil(() => readCredentialsMock.mock.results[0]?.type === 'return');
      await new Promise((resolve) => setImmediate(resolve));
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('does not let an older live settings version invalidate a newer in-flight apply', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const newerCredentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => newerCredentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-newer-v5',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 5,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.trigger('update', {
        id: 'settings-older-v4',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
            version: 4,
          },
        },
      });
      newerCredentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await waitUntil(() => getActiveAccountSettingsSnapshot()?.settingsVersion === 5);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('requires the real user socket to remain connected before a live settings commit', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const credentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => credentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-before-disconnect',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.disconnect();
      credentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('publishes one broaden wake when queued live settings updates finish with broader eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
        settingsVersion: 20,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();
      const foregroundSettingsContent = {
        t: 'encrypted' as const,
        c: encodeBase64(encrypt(accountSettingsCredentialsSecret, 'legacy', {
          sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        })),
      };

      userSocketStub.trigger('update', {
        id: 'account-settings-v21',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: foregroundSettingsContent, version: 21 },
        },
      });
      userSocketStub.trigger('update', {
        id: 'account-settings-v22',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: foregroundSettingsContent, version: 22 },
        },
      });

      await expect(Promise.race([
        wake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(22);

      const duplicateWaitAbort = new AbortController();
      const duplicateWait = client.waitForMetadataUpdate(duplicateWaitAbort.signal);
      let duplicateWake: boolean | null = null;
      void duplicateWait.then((value) => {
        duplicateWake = value;
      });
      await Promise.resolve();
      expect(duplicateWake).toBeNull();
      duplicateWaitAbort.abort();
      await expect(duplicateWait).resolves.toBe(false);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('does not publish a Pending eligibility wake when live settings narrow ordinary delivery', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 1,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      if (!userSocketStub) throw new Error('missing user socket stub');

      const abort = new AbortController();
      const wake = client.waitForPendingEligibilityUpdate(abort.signal);
      userSocketStub.trigger('update', {
        id: 'account-settings-narrow-v2',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 2,
          },
        },
      });
      await waitUntil(() => getActiveAccountSettingsSnapshot()?.settingsVersion === 2);
      abort.abort();

      await expect(wake).resolves.toBe(false);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('releases a fail-closed Pending hint after malformed settings and retries convergence on the same socket', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 1,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');

      const failedWake = client.waitForPendingEligibilityUpdate();
      userSocketStub.trigger('update', {
        id: 'account-settings-malformed-v2-recovery',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 2 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-malformed-settings',
        seq: 3,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });
      await expect(Promise.race([
        failedWake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);

      get.mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 3,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      expect(get).toHaveBeenCalledTimes(2);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(3);
      expect((client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier).toBeNull();
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it.each([
    {
      name: 'malformed payload',
      prepare: () => {},
      settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
    },
    {
      name: 'missing credentials',
      prepare: () => readCredentialsMock.mockResolvedValueOnce(null),
      settingsV2: { content: { t: 'plain', v: {} }, version: 1 },
    },
  ])('preserves verdict-free wakes and unrelated updates after a failed live settings update: $name', async ({ prepare, settingsV2 }) => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();
      const unrelatedUpdates: unknown[] = [];
      client.on('message', (message) => unrelatedUpdates.push(message));
      prepare();

      userSocketStub.trigger('update', {
        id: 'account-settings-failed',
        seq: 1,
        createdAt: Date.now(),
        body: { t: 'update-account', id: 'account-1', settingsV2 },
      });
      userSocketStub.trigger('update', {
        id: 'unrelated-automation-update',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'automation-upsert',
          automationId: 'automation-1',
          version: 1,
          enabled: true,
          updatedAt: Date.now(),
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-failed-settings',
        seq: 3,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      await waitUntil(() => unrelatedUpdates.length === 1);
      expect(unrelatedUpdates).toHaveLength(1);
      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('preserves unrelated update-session state when a live settings update cannot be applied', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 10,
        runtimeActivityRevision: 1,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const metadataWake = client.waitForMetadataUpdate();
      const pendingWakeSeqBefore = (client as unknown as { pendingWakeSeq: number }).pendingWakeSeq;
      materializeNextMock.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({ deliveryTiming: 'after_runtime_idle' });
        expect(params.expectedRuntimeActivityRevision).toBeUndefined();
        return {
          didMaterialize: false,
          deferredReason: 'waiting_for_runtime_activity',
          pendingQueueState: {
            known: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
          },
        };
      });

      userSocketStub.trigger('update', {
        id: 'account-settings-decrypt-failed',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'mixed-session-state-after-failed-settings',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 10,
            value: JSON.stringify({ path: '/synthetic/live-settings-state-preserved' }),
          },
          runtimeActivityState: 'idle',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: 20,
          runtimeActivityRevision: 2,
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      await Promise.resolve();

      expect((client as unknown as { metadata: { path?: string } | null }).metadata?.path)
        .toBe('/synthetic/live-settings-state-preserved');
      await expect(metadataWake).resolves.toBe(true);
      expect((client as unknown as { runtimeActivityProjection: { runtimeActivityState?: string } })
        .runtimeActivityProjection.runtimeActivityState).toBe('idle');
      expect((client as unknown as { pendingWakeSeq: number }).pendingWakeSeq).toBe(pendingWakeSeqBefore + 1);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'deferred', reason: 'waiting_for_runtime_activity' });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('keeps an explicit steer eligible after a live settings update cannot be applied', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'in_progress',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const pendingWake = client.waitForMetadataUpdate();
      const delivered: Array<{ info?: { pendingProviderAction?: string } }> = [];
      client.onUserMessage((_message, info) => delivered.push({ info }));

      userSocketStub.trigger('update', {
        id: 'account-settings-decrypt-failed-before-steer',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'explicit-steer-after-failed-settings',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await expect(Promise.race([
        pendingWake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);
      materializeNextMock.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({
          deliveryTiming: 'after_runtime_idle',
          foregroundState: 'active_steerable',
        });
        const result = createProviderDeliveryMaterializeResult('explicit-steer-local', 2);
        return {
          ...result,
          pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
          message: { ...result.message, providerAction: 'steer' as const },
        };
      });

      await expect(client.materializeNextPendingMessageSafely({
        reconcileWhenEmpty: 'force',
        activeTurnSteerability: 'steerable',
      })).resolves.toMatchObject({ type: 'materialized', localId: 'explicit-steer-local' });
      expect(delivered).toEqual([{ info: expect.objectContaining({ pendingProviderAction: 'steer' }) }]);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('releases canonical local custody after a current server requeues a conditional steer', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    const localId = 'conditional-steer-current-server';
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        requestedAction: { v: 1 as const, kind: 'steer_if_active' as const },
        providerAction: 'steer' as const,
      },
    });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
    });

    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
    })).resolves.toMatchObject({ type: 'materialized', localId });
    await expect(client.blockPendingMessageDelivery({
      localIds: [localId],
      reason: 'steering_unavailable',
      providerEffect: 'none',
    })).resolves.toBe(true);

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId,
      reason: 'conditional_steer_unavailable',
    });
    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(false);
    expect((client as any).pendingQueueMaterializedLocalIds.has(localId)).toBe(false);
    expect((client as any).agentQueueEchoSuppressedLocalIds.has(localId)).toBe(false);
  });

  it.each([false, true])('[bound-lifetime] refuses an admitted unclaimed action after the original run closes instead of handing it to a successor turn (bound-capable=%s)', async (boundSuccessor) => {
    const original = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    await waitForCurrentPendingInputContract(original);
    const localId = ' exact-successor-row ';
    let durableAction: unknown;
    vi.spyOn(axios, 'patch').mockImplementationOnce(async (_url, body) => {
      durableAction = (body as { requestedAction: unknown }).requestedAction;
      return { data: { ok: true, didUpdate: true, requestedAction: durableAction } };
    });
    materializeNextMock.mockResolvedValue({ didMaterialize: false });
    const inputConsumer = createSessionProviderInputConsumer({
      session: original,
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      activeTurnSteerability: 'steerable',
    });
    const { createCodexPendingInputSteerControl, createCodexPendingInputBoundSteerHandler } = await import('@/backends/codex/runCodex');
    const turnBindings: Parameters<typeof createCodexPendingInputSteerControl>[0]['turnBindings'] = new Map();
    const control = createCodexPendingInputSteerControl({ getDispatchSignal: () => new AbortController().signal, session: original, isAdmissionOpen: () => true,
      runtime: { getActiveSteerableTurnId: async () => 'T1' }, inputConsumer, turnBindings });
    vi.useFakeTimers();
    const result = control({ sessionId: original.sessionId, localId });
    await vi.waitFor(() => expect(durableAction).toBeDefined());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({ ok: true, status: 'admitted_delivery_unobserved' });
    await inputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
    turnBindings.clear();
    await original.close();
    vi.useRealTimers();

    const successor = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 2, metadata: { flavor: 'codex' } });
    const steerT2 = vi.fn();
    const lookUpT2 = vi.fn(async () => 'T2');
    const successorBindings: Parameters<typeof createCodexPendingInputBoundSteerHandler>[0]['turnBindings'] = new Map();
    const bridge = createCodexAppServerProviderInputOutcomeBridge(successor, { isCurrentRuntimeMode: () => true });
    const successorRuntime = { getActiveSteerableTurnId: lookUpT2 };
    successor.onUserMessage(steerT2, boundSuccessor ? { onBoundCodexSteer: createCodexPendingInputBoundSteerHandler({
      turnBindings: successorBindings,
      getRuntime: () => successorRuntime,
      isAdmissionOpen: () => true,
      steer: async () => { steerT2(); },
      refuse: async (localId) => { bridge.observeRejectedBeforeEffect({ localIds: [localId], reason: 'steering_unavailable' }); },
    }) } : undefined);
    const claim = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: durableAction, providerAction: 'steer' } });
    await successor.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force', activeTurnSteerability: 'steerable' });
    expect(steerT2).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(blockPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId, reason: boundSuccessor ? 'steering_unavailable' : 'unsupported_action' })));
    expect(lookUpT2).not.toHaveBeenCalled();
    expect(successorBindings.size).toBe(0);
    expect(turnBindings.size).toBe(0);
    expect(axios.patch).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'claude', 'replacement'] as const)('[bound-lifetime] refuses %s without ordinary callback or generic buffer replay', async (consumer) => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: consumer === 'claude' ? 'claude' : 'codex' } });
    const ordinary = vi.fn();
    const bound = vi.fn();
    if (consumer === 'replacement') client.onUserMessage(ordinary, { onBoundCodexSteer: bound });
    if (consumer !== 'none') client.onUserMessage(ordinary);
    const localId = `unsupported-bound-${consumer}`;
    const claim = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force', activeTurnSteerability: 'steerable' });
    client.onUserMessage(ordinary);
    expect(ordinary).not.toHaveBeenCalled();
    expect(bound).not.toHaveBeenCalled();
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId, reason: 'unsupported_action' }));
  });

  it.each(['send', 'interrupt_and_send'] as const)('[bound-lifetime] refuses contradictory provider operation %s', async (providerAction) => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1 });
    const ordinary = vi.fn();
    const bound = vi.fn();
    client.onUserMessage(ordinary, { onBoundCodexSteer: bound });
    const claim = createProviderDeliveryMaterializeResult('contradictory-bound');
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction } });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(ordinary).not.toHaveBeenCalled();
    expect(bound).not.toHaveBeenCalled();
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unsupported_action' }));
  });

  it.each(['replace', 'terminate'] as const)('[bound-lifetime] revokes an awaiting handler when registration changes: %s', async (effect) => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1 });
    const preparing = createDeferred<void>();
    const entered = createDeferred<void>();
    const provider = vi.fn();
    const ordinary = vi.fn();
    client.onUserMessage(ordinary, { onBoundCodexSteer: async (_message, delivery) => {
      expect(delivery.requestedAction).toEqual({ v: 1, kind: 'steer_now_bound', bindingId: 'B1' });
      expect(delivery.isCurrentRegistration()).toBe(true);
      entered.resolve();
      await preparing.promise;
      if (delivery.isCurrentRegistration()) provider();
    } });
    const claim = createProviderDeliveryMaterializeResult('awaiting-bound');
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    const delivery = client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    await entered.promise;
    if (effect === 'replace') client.onUserMessage(ordinary);
    else client.beginRuntimeTermination();
    preparing.resolve();
    await delivery;
    expect(provider).not.toHaveBeenCalled();
    expect(ordinary).not.toHaveBeenCalled();
  });

  it('[bound-lifetime] retains canonical custody after failed unsupported block and accepts a later qualified observation', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    const localId = 'failed-block-bound';
    const claim = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    blockPendingDeliveryMock.mockRejectedValueOnce(new Error('offline block response lost'));
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    bridge.observeAccepted({ localIds: [localId], providerTurnId: 'T1' });
    await vi.waitFor(() => expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId })));
  });

  it('[bound-lifetime] never conditionally requeues a qualified bound refusal', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    const localId = 'bound-refusal';
    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    client.onUserMessage(() => { throw new Error('ordinary callback'); }, { onBoundCodexSteer: () => { bridge.observeRejectedBeforeEffect({ localIds: [localId], reason: 'steering_unavailable' }); } });
    const claim = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    await vi.waitFor(() => expect(blockPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId, reason: 'steering_unavailable' })));
    expect(blockPendingDeliveryMock.mock.calls.every(([request]) => request.reason !== 'conditional_steer_unavailable')).toBe(true);
  });

  it.each(['enqueue', 'steer_if_active', 'steer_now', 'send_now'] as const)('[bound-lifetime] keeps ordinary %s delivery with a bound-capable registration', async (kind) => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1 });
    const ordinary = vi.fn();
    const bound = vi.fn();
    client.onUserMessage(ordinary, { onBoundCodexSteer: bound });
    const claim = createProviderDeliveryMaterializeResult(`ordinary-${kind}`);
    materializeNextMock.mockResolvedValueOnce({ ...claim, message: { ...claim.message, requestedAction: { v: 1, kind }, providerAction: kind.startsWith('steer') ? 'steer' : 'send' } });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect(bound).not.toHaveBeenCalled();
  });

  it.each([
    { v: 1, kind: 'steer_now_bound', bindingId: 'B2' },
    { v: 1, kind: 'steer_now' },
    { v: 1, kind: 'steer_now_bound' },
  ])('[bound-lifetime] preserves uncertain admission on a mismatched acknowledgement: %j', async (requestedAction) => {
    const client = await createClient({ pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    vi.spyOn(axios, 'patch').mockResolvedValueOnce({ data: { ok: true, didUpdate: true, requestedAction } });
    await expect(client.requestPendingInputSteerNow('L', 'B1')).resolves.toEqual({ kind: 'admission_uncertain' });
    expect(axios.patch).toHaveBeenCalledTimes(1);
  });

  it('observes a real Codex bridge rejection before durable block cleanup retires the claim', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { flavor: 'codex' },
    });
    await waitForCurrentPendingInputContract(client);
    const localId = 'exact-steer-ended-turn';
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: { ...materialized.message, requestedAction: { v: 1, kind: 'steer_now' }, providerAction: 'steer' },
    });

    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    client.onUserMessage(() => { throw new Error('Bound action reached ordinary callback'); }, { onBoundCodexSteer: () => {
      bridge.observeRejectedBeforeEffect({ localIds: [localId], reason: 'steering_unavailable' });
    } });
    vi.spyOn(axios, 'patch').mockImplementationOnce(async (_url, body) => {
      const requestedAction = (body as { requestedAction: unknown }).requestedAction;
      materializeNextMock.mockReset();
      materializeNextMock.mockResolvedValueOnce({ ...materialized, message: { ...materialized.message, requestedAction, providerAction: 'steer' } });
      return { data: { ok: true, didUpdate: true, requestedAction } };
    });
    const inputConsumer = createSessionProviderInputConsumer({
      session: client,
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      activeTurnSteerability: 'steerable',
    });
    const { createCodexPendingInputSteerControl } = await import('@/backends/codex/runCodex');
    const control = createCodexPendingInputSteerControl({ getDispatchSignal: () => new AbortController().signal,
      session: client,
      isAdmissionOpen: () => true,
      runtime: { getActiveSteerableTurnId: async () => 'captured-native-turn' },
      inputConsumer,
      turnBindings: new Map(),
    });
    await expect(control({ sessionId: client.sessionId, localId }))
      .resolves.toMatchObject({ ok: false, status: 'interrupt_failed', errorCode: 'steering_unavailable' });
    await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false));
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId, reason: 'steering_unavailable' }));
  });

  it.each([true, false])('[bound-retry-outcome] joins the original durable refusal before retry (settled=%s)', async (settled) => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    await waitForCurrentPendingInputContract(client);
    const localId = 'retry-after-held-refusal';
    const block = createDeferred<{ pendingQueueState: { known: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number } }>();
    blockPendingDeliveryMock.mockReturnValueOnce(block.promise);
    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    const { createCodexPendingInputSteerControl, createCodexPendingInputBoundSteerHandler } = await import('@/backends/codex/runCodex');
    const runtime = { getActiveSteerableTurnId: vi.fn().mockResolvedValueOnce('T1').mockResolvedValue('T2') };
    const turnBindings: Parameters<typeof createCodexPendingInputSteerControl>[0]['turnBindings'] = new Map();
    const steer = vi.fn(async () => { bridge.observeAccepted({ localIds: [localId], providerTurnId: 'T2' }); });
    client.onUserMessage(() => { throw new Error('Bound action reached ordinary callback'); }, {
      onBoundCodexSteer: createCodexPendingInputBoundSteerHandler({
        turnBindings, getRuntime: () => runtime, isAdmissionOpen: () => true, steer,
        refuse: async () => { bridge.observeRejectedBeforeEffect({ localIds: [localId], reason: 'steering_unavailable' }); },
      }),
    });
    const materialized = createProviderDeliveryMaterializeResult(localId);
    let attempt = 0;
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      attempt += 1;
      if (attempt === 2) {
        await block.promise;
        await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false));
        sessionSocketStub!.trigger('update', {
          id: 'retry-action-unblocked', createdAt: Date.now(),
          body: { t: 'pending-changed', sid: client.sessionId, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
        });
      }
      const requestedAction = (body as { requestedAction: unknown }).requestedAction;
      materializeNextMock.mockReset();
      materializeNextMock.mockResolvedValueOnce({ ...materialized, message: { ...materialized.message, requestedAction, providerAction: 'steer' } }).mockResolvedValue({ didMaterialize: false });
      return { data: { ok: true, didUpdate: true, requestedAction } };
    });
    const inputConsumer = createSessionProviderInputConsumer({ session: client, messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'), activeTurnSteerability: 'steerable' });
    const control = createCodexPendingInputSteerControl({ session: client, runtime, inputConsumer, turnBindings, isAdmissionOpen: () => true, getDispatchSignal: () => new AbortController().signal });
    await expect(control({ sessionId: client.sessionId, localId })).resolves.toMatchObject({ ok: false, errorCode: 'steering_unavailable' });
    expect(turnBindings.has(localId)).toBe(false);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    const retry = control({ sessionId: client.sessionId, localId });
    await vi.waitFor(() => expect(turnBindings.get(localId)?.turnId).toBe('T2'));
    if (settled) {
      block.resolve({ pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 } });
    } else {
      block.reject(new Error('original durable block response lost'));
    }
    const result = await retry;
    if (settled) {
      expect(steer).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, status: 'admitted_and_steered', sessionId: client.sessionId, localId });
      expect(axios.patch).toHaveBeenCalledTimes(2);
    } else {
      expect(steer).not.toHaveBeenCalled();
      expect(axios.patch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, errorCode: 'pending_input_steer_unavailable' });
      expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
      await expect(client.waitForProviderInputTerminalOutcome(localId)).resolves.toMatchObject({ kind: 'rejected_before_effect', reason: 'steering_unavailable' });
    }
  });

  it('[bound-retry-outcome] retains uncertain custody and allows its later qualified acceptance', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    await waitForCurrentPendingInputContract(client);
    const localId = 'uncertain-bound-retry';
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...materialized, message: { ...materialized.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    const observe = providerInputOutcomeObserver(client);
    client.onUserMessage(() => { throw new Error('Bound action reached ordinary callback'); }, { onBoundCodexSteer: () => {} });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    observe({ kind: 'effect_may_have_occurred', localId });
    await vi.waitFor(() => expect(blockPendingDeliveryMock).toHaveBeenCalled());
    const patch = vi.spyOn(axios, 'patch');
    await expect(client.requestPendingInputSteerNow(localId, 'B2')).resolves.toMatchObject({ kind: 'not_admitted' });
    expect(patch).not.toHaveBeenCalled();
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    await expect(client.waitForProviderInputTerminalOutcome(localId)).resolves.toEqual({ kind: 'pending' });
    observe({ kind: 'accepted', localId, providerTurnId: 'T1' });
    await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false));
  });

  it('[bound-retry-outcome] preserves accepted custody and its terminal observation without another PATCH', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' } });
    await waitForCurrentPendingInputContract(client);
    const localId = 'accepted-bound-retry';
    const settlement = createDeferred<{ didResolve: boolean }>();
    resolveAcceptedPendingDeliveryMock.mockReturnValueOnce(settlement.promise);
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({ ...materialized, message: { ...materialized.message, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' }, providerAction: 'steer' } });
    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    client.onUserMessage(() => { throw new Error('Bound action reached ordinary callback'); }, { onBoundCodexSteer: () => {} });
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    bridge.observeAccepted({ localIds: [localId], providerTurnId: 'T1' });
    await vi.waitFor(() => expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalled());
    const patch = vi.spyOn(axios, 'patch');
    await expect(client.requestPendingInputSteerNow(localId, 'B2')).resolves.toMatchObject({ kind: 'not_admitted' });
    expect(patch).not.toHaveBeenCalled();
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    await expect(client.waitForProviderInputTerminalOutcome(localId)).resolves.toEqual({ kind: 'accepted', providerTurnId: 'T1' });
    settlement.resolve({ didResolve: true });
    await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false));
  });

  it('retains acknowledged exact-steer admission when the connection changes after the PATCH', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    vi.spyOn(axios, 'patch').mockImplementationOnce(async () => {
      sessionSocketStub!.connected = false;
      return { data: { ok: true, didUpdate: true, requestedAction: { v: 1, kind: 'steer_now_bound', bindingId: 'B1' } } };
    });
    await expect(client.requestPendingInputSteerNow('ack-after-disconnect', 'B1')).resolves.toEqual({ kind: 'admitted' });
  });

  it('distinguishes uncertain exact-steer admission from an authoritative action rejection', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    const patch = vi.spyOn(axios, 'patch');
    patch.mockRejectedValueOnce(new Error('transport timeout after possible commit'));
    await expect(client.requestPendingInputSteerNow('uncertain-admission', 'B1')).resolves.toEqual({ kind: 'admission_uncertain' });
    patch.mockRejectedValueOnce(createPendingDeliveryHttpError(409, 'action-conflict'));
    await expect(client.requestPendingInputSteerNow('rejected-admission', 'B1')).resolves.toEqual({ kind: 'not_admitted', reason: 'server_rejected' });
  });

  it('cancels a terminal-outcome waiter without leaving an active localId subscription', async () => {
    const client = await createClient({ pendingCount: 1, pendingVersion: 1 });
    vi.useFakeTimers();
    const controller = new AbortController();
    const outcome = client.waitForProviderInputTerminalOutcome('cancelled-outcome-wait', 100, controller.signal);
    controller.abort();
    await expect(outcome).resolves.toEqual({ kind: 'pending' });
  });

  it.each([false, true])('keeps the native turn binding without claiming delivery when admission is acknowledged: %s', async (acknowledged) => {
    const client = await createClient({
      latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' },
    });
    await waitForCurrentPendingInputContract(client);
    const patch = vi.spyOn(axios, 'patch');
    if (acknowledged) {
      patch.mockImplementationOnce(async (_url, body) => ({ data: { ok: true, didUpdate: true, requestedAction: (body as { requestedAction: unknown }).requestedAction } }));
    } else {
      patch.mockRejectedValueOnce(new Error('transport timeout after possible commit'));
    }
    materializeNextMock.mockResolvedValue({ didMaterialize: false });
    const inputConsumer = createSessionProviderInputConsumer({
      session: client,
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      activeTurnSteerability: 'steerable',
    });
    const turnBindings: Parameters<typeof import('@/backends/codex/runCodex').createCodexPendingInputSteerControl>[0]['turnBindings'] = new Map();
    const { createCodexPendingInputSteerControl } = await import('@/backends/codex/runCodex');
    const control = createCodexPendingInputSteerControl({ getDispatchSignal: () => new AbortController().signal,
      session: client,
      isAdmissionOpen: () => true,
      runtime: { getActiveSteerableTurnId: async () => 'captured-native-turn' },
      inputConsumer,
      turnBindings,
    });
    vi.useFakeTimers();
    const result = control({ sessionId: client.sessionId, localId: 'uncertain-control-local' });
    await vi.waitFor(() => expect(materializeNextMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject(acknowledged
      ? { ok: true, status: 'admitted_delivery_unobserved' }
      : { ok: false, status: 'interrupt_failed', errorCode: 'pending_input_steer_admission_uncertain' });
    expect(turnBindings.get('uncertain-control-local')).toMatchObject({ turnId: 'captured-native-turn', bindingId: expect.any(String) });
    expect(client.hasCanonicalPendingProviderInputDelivery('uncertain-control-local')).toBe(false);
    await expect(control({ sessionId: client.sessionId, localId: 'uncertain-control-local' }))
      .resolves.toMatchObject({ ok: false, status: 'not_safe' });
    expect(axios.patch).toHaveBeenCalledTimes(1);
  });

  it('observes provider acceptance during the admission PATCH before claim settlement clears its outcome', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress', pendingCount: 1, pendingVersion: 1, metadata: { flavor: 'codex' },
    });
    await waitForCurrentPendingInputContract(client);
    const localId = 'accepted-during-admission';
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: { ...materialized.message, requestedAction: { v: 1, kind: 'steer_now' }, providerAction: 'steer' },
    }).mockResolvedValue({ didMaterialize: false });
    const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
    client.onUserMessage(() => { throw new Error('Bound action reached ordinary callback'); }, { onBoundCodexSteer: () => {
      bridge.observeAccepted({ localIds: [localId], providerTurnId: 'captured-native-turn' });
    } });
    vi.spyOn(axios, 'patch').mockImplementationOnce(async (_url, body) => {
      const requestedAction = (body as { requestedAction: unknown }).requestedAction;
      materializeNextMock.mockReset();
      materializeNextMock.mockResolvedValueOnce({ ...materialized, message: { ...materialized.message, requestedAction, providerAction: 'steer' } }).mockResolvedValue({ didMaterialize: false });
      await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false));
      return { data: { ok: true, didUpdate: true, requestedAction } };
    });
    const inputConsumer = createSessionProviderInputConsumer({
      session: client,
      messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
      activeTurnSteerability: 'steerable',
    });
    const { createCodexPendingInputSteerControl } = await import('@/backends/codex/runCodex');
    const control = createCodexPendingInputSteerControl({ getDispatchSignal: () => new AbortController().signal,
      session: client,
      isAdmissionOpen: () => true,
      runtime: { getActiveSteerableTurnId: async () => 'captured-native-turn' },
      inputConsumer,
      turnBindings: new Map(),
    });
    await expect(control({ sessionId: client.sessionId, localId }))
      .resolves.toEqual({ ok: true, status: 'admitted_and_steered', sessionId: client.sessionId, localId });
  });

  it('does not reopen local delivery when an older server degrades the settlement to a strict block', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    const localId = 'conditional-steer-legacy-server';
    const materialized = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        requestedAction: { v: 1 as const, kind: 'steer_if_active' as const },
        providerAction: 'steer' as const,
      },
    });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
      usedLegacySteeringUnavailableFallback: true,
    });

    await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
    });
    await expect(client.blockPendingMessageDelivery({
      localIds: [localId],
      reason: 'steering_unavailable',
      providerEffect: 'none',
    })).resolves.toBe(true);

    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(false);
    expect((client as any).pendingQueueMaterializedLocalIds.has(localId)).toBe(false);
    expect((client as any).agentQueueEchoSuppressedLocalIds.has(localId)).toBe(true);
  });

  it('preserves unresolved-head backpressure instead of reporting no pending work', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      deferredReason: 'waiting_for_predecessor',
      pendingQueueState: {
        known: true,
        pendingCount: 2,
        pendingBlockedCount: 0,
        pendingVersion: 7,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({
      type: 'deferred',
      reason: 'waiting_for_predecessor',
    });
  });

  it('returns typed retryable transport without arming a client retry timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude', observedAt: Date.now() });
    const transportFailure = new PendingQueueMaterializationTransportAmbiguousError(
      new Error('materialize acknowledgement timed out'),
    );
    materializeNextMock
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce({
        didMaterialize: true,
        didWrite: true,
        localId: 'local-retry',
        message: {
          seq: 10,
          localId: 'local-retry',
          messageRole: 'user',
          content: { role: 'user', content: { type: 'text', text: 'retry wake' } },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        pendingQueueState: {
          known: true,
          pendingCount: 0,
          pendingBlockedCount: 0,
          pendingVersion: 2,
        },
      });

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'pending-changed-retry',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingVersion: 1,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({
      activeTurnSteerability: 'steerable',
    })).resolves.toEqual({ type: 'retryable_transport', retryAfterMs: 250 });
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] materialize request failed',
      expect.objectContaining({
        sessionId: 's1',
        error: expect.objectContaining({
          code: 'pending_queue_materialization_transport_ambiguous',
          diagnosticCode: 'pending_queue_materialization_transport_failure',
          classification: 'transport_failure',
          cause: expect.objectContaining({ message: 'materialize acknowledgement timed out' }),
        }),
      }),
    );
    expect(infoFileSpy).toHaveBeenCalledTimes(1);
    expect((client as unknown as { pendingMaterializeRetryWakeTimer?: unknown }).pendingMaterializeRetryWakeTimer)
      .toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);

    await expect(client.materializeNextPendingMessageSafely({
      activeTurnSteerability: 'steerable',
    })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'local-retry',
      seq: 10,
    });
    expect(client.sessionTurnLifecycle.hasActiveTurn()).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  describe('lost pending publisher', () => {
    const publisherLost = () => new PendingQueueMaterializationTransportAmbiguousError(
      new Error('Pending queue materialize server acknowledgement: forbidden'),
      'publisher_lost',
      'forbidden',
    );
    const readWakeCapability = (client: Awaited<ReturnType<typeof createClient>>) =>
      client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1, {});
    const servableCapability = {
      ok: true,
      capability: 'pending_queue_wake_v1',
      protocolVersion: 1,
      method: SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1,
    };
    // The terminal report names this exact process, computed the way the daemon reads a pid's instance.
    const publisherLostCapability = {
      ok: false,
      error: 'pending_materialization_wake_unavailable',
      errorCode: 'publisher_lost',
      respondent: {
        machineId: 'machine-1',
        pid: process.pid,
        processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid),
      },
    };
    const publisherRecoveringCapability = {
      ok: false,
      error: 'pending_materialization_wake_unavailable',
      errorCode: 'publisher_recovering',
    };
    const reconnect = async () => {
      if (!supervisorOnConnected) throw new Error('missing supervised reconnect callback');
      await supervisorOnConnected();
    };

    it('reconnects once, then stops materializing and reports publisher_lost until a new publisher claim', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockRejectedValue(publisherLost());

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'retry_later' }),
      );
      // A refusal on the same connection while the reconnect is pending is not a second episode.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherRecoveringCapability);

      await reconnect();
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(materializeNextMock).toHaveBeenCalledTimes(3);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherLostCapability);

      // Terminal: later wakes neither re-materialize nor reconnect.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(materializeNextMock).toHaveBeenCalledTimes(3);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);

      // An independent connection that claims publisher status clears the terminal state.
      await reconnect();
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);
    });

    // An accepted provider input whose settlement the server refuses as `forbidden` is held until a
    // connection that publishes the session settles it; meanwhile it blocks every materialization.
    const holdAcceptedInputRefusedForbidden = async (localId: string) => {
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId));
      listDeliveryStatusesMock.mockResolvedValue([{ localId, status: 'delivering' }]);
      resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('forbidden'));
      client.onUserMessage(() => confirmProviderInputAccepted(client, localId));
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toMatchObject({ type: 'materialized', localId });
      await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
      return client;
    };

    it('reconnects once when a settlement is refused forbidden, and the new connection settles the held input', async () => {
      const warningSpy = vi.spyOn(logger, 'warn');
      const client = await holdAcceptedInputRefusedForbidden('settle-forbidden-reclaimed');

      await waitUntil(() => supervisorReportProbeResultMock.mock.calls.length === 1);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'retry_later' }),
      );
      expect(warningSpy).toHaveBeenCalledWith('[pendingQueue] accepted provider settlement remains unresolved', expect.objectContaining({
        sessionId: 's1', localId: 'settle-forbidden-reclaimed', attempt: 1, retryAfterMs: null, willRetry: false,
        retryDisposition: 'retained_for_publisher_recovery', failure: { kind: 'server_ack', error: 'forbidden' },
      }));
      await expect(readWakeCapability(client)).resolves.toEqual(publisherRecoveringCapability);
      expect(client.hasCanonicalPendingProviderInputDelivery('settle-forbidden-reclaimed')).toBe(true);

      // The reconnect claims publisher status and re-offers the held settlement on the new connection.
      resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });
      await reconnect();
      await waitUntil(() => !client.hasCanonicalPendingProviderInputDelivery('settle-forbidden-reclaimed'));
      expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);
    });

    it('reports publisher_lost, not no_pending, while a held settlement is refused on the reclaimed connection too', async () => {
      const client = await holdAcceptedInputRefusedForbidden('settle-forbidden-terminal');
      await waitUntil(() => supervisorReportProbeResultMock.mock.calls.length === 1);

      resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('forbidden'));
      await reconnect();
      await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 2);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherLostCapability);

      // The held input still blocks materialization, but a wake now reports why.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);
      expect(client.hasCanonicalPendingProviderInputDelivery('settle-forbidden-terminal')).toBe(true);
    });

    it('completes an unreclaimed recovery as publisher_lost at its deadline, without another reconnect', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      vi.useFakeTimers();
      materializeNextMock.mockRejectedValue(publisherLost());

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);
      // The replacement connection never completes publisher readiness.
      await vi.advanceTimersByTimeAsync(configuration.pendingPublisherRecoveryDeadlineMs - 1);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherRecoveringCapability);
      await vi.advanceTimersByTimeAsync(1);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherLostCapability);

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);

      // A later independently converged connection still clears the terminal state.
      await reconnect();
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);
    });

    it('cancels the deadline when the reconnect reclaims publisher status in time', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      vi.useFakeTimers();
      materializeNextMock.mockRejectedValueOnce(publisherLost());

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      await vi.advanceTimersByTimeAsync(configuration.pendingPublisherRecoveryDeadlineMs - 1);
      await reconnect();
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);

      await vi.advanceTimersByTimeAsync(configuration.pendingPublisherRecoveryDeadlineMs);
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);
    });

    it('arms no recovery deadline for a refusal that lands while close is in progress', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      vi.useFakeTimers();
      const infoFileSpy = vi.spyOn(logger, 'infoFile');
      const refusal = createDeferred<never>();
      materializeNextMock.mockReturnValueOnce(refusal.promise);
      // Hold close inside its drain window, after its early timer cleanup and before `closed`.
      const closeDrainGate = createDeferred<void>();
      const waitForIdle = vi.spyOn(client.rpcHandlerManager, 'waitForIdle').mockImplementation(async () => {
        await closeDrainGate.promise;
      });

      const materialization = client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      await vi.waitFor(() => expect(materializeNextMock).toHaveBeenCalledTimes(1));
      const closing = client.close();
      try {
        await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalled());
        refusal.reject(publisherLost());
        await materialization;

        expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
        expect((client as unknown as { pendingPublisherRecoveryDeadlineTimer: unknown }).pendingPublisherRecoveryDeadlineTimer)
          .toBeNull();
      } finally {
        closeDrainGate.resolve();
        await closing;
      }

      await vi.advanceTimersByTimeAsync(configuration.pendingPublisherRecoveryDeadlineMs);
      expect((client as unknown as { pendingPublisherRecovery: { state: string } }).pendingPublisherRecovery.state)
        .toBe('current');
      expect(infoFileSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('before its deadline'),
        expect.anything(),
      );
    });

    it('does not let an earlier episode deadline end a newer episode', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      vi.useFakeTimers();
      const deadlineMs = configuration.pendingPublisherRecoveryDeadlineMs;
      const halfDeadlineMs = Math.floor(deadlineMs / 2);
      materializeNextMock
        .mockRejectedValueOnce(publisherLost())
        .mockResolvedValueOnce({
          didMaterialize: false,
          localId: null,
          didWrite: false,
          pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
        })
        .mockRejectedValueOnce(publisherLost());

      // Episode 1 reclaims, and an accepted claim ends it.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      await reconnect();
      await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      await vi.advanceTimersByTimeAsync(halfDeadlineMs);

      // Episode 2 starts later; episode 1's deadline instant passes without ending it.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(deadlineMs - halfDeadlineMs);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherRecoveringCapability);

      await vi.advanceTimersByTimeAsync(halfDeadlineMs);
      await expect(readWakeCapability(client)).resolves.toEqual(publisherLostCapability);
    });

    it('recovers normally when the one reconnect reclaims publisher status', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock
        .mockRejectedValueOnce(publisherLost())
        .mockResolvedValueOnce({
          didMaterialize: true,
          localId: 'local-after-reconnect',
          didWrite: true,
          message: {
            id: 'm-after-reconnect',
            seq: 10,
            localId: 'local-after-reconnect',
            messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'after reconnect' } } },
            createdAt: 1000,
            updatedAt: 1000,
          },
          pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
        })
        .mockRejectedValueOnce(publisherLost());

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(1);

      await reconnect();
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toMatchObject({ type: 'materialized', localId: 'local-after-reconnect', seq: 10 });
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);

      // Success closed the episode, so a later loss gets its own single reconnect.
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'publisher_lost' });
      expect(supervisorReportProbeResultMock).toHaveBeenCalledTimes(2);
    });

    it('keeps transaction-unavailable on the transport retry path without reconnecting', async () => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockRejectedValue(new PendingQueueMaterializationTransportAmbiguousError(
        new Error('Pending queue materialize server acknowledgement: transaction-unavailable'),
        'server_retryable',
        'transaction-unavailable',
        1_000,
      ));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
          .resolves.toEqual({ type: 'retryable_transport', retryAfterMs: 1_000 });
      }
      expect(materializeNextMock).toHaveBeenCalledTimes(3);
      expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
      await expect(readWakeCapability(client)).resolves.toEqual(servableCapability);
    });
  });

  it('identifies the server-claim subphase before awaiting an unsettled materialization transport', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    const transport = createDeferred<{
      didMaterialize: false;
      localId: null;
      didWrite: false;
    }>();
    materializeNextMock.mockImplementationOnce(async () => await transport.promise);
    const observedPhases: string[] = [];
    const pending = client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: (phase) => observedPhases.push(phase),
    });

    try {
      await vi.waitFor(() => expect(materializeNextMock).toHaveBeenCalledTimes(1));
      expect(observedPhases.at(-1)).toBe('materialize.server_claim');
    } finally {
      transport.resolve({ didMaterialize: false, localId: null, didWrite: false });
      await pending;
    }
  });

  it('keeps diagnostic callback failures outside pending materialization behavior', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      localId: null,
      didWrite: false,
    });

    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: () => {
        throw new Error('diagnostic callback failed');
      },
    })).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('passes runtime-idle delivery timing to server materialization when locally eligible', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryTiming: 'after_runtime_idle',
    }));
  });

  it('ignores inert continuation recovery metadata when deciding pending materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: {
        sessionContinuationRecoveryV1: {
          v: 1,
          attemptsById: {
            'generation-1:restart-1': {
              v: 1,
              attemptId: 'generation-1:restart-1',
              status: 'pending_provider_context',
              failureAtMs: 100,
              updatedAtMs: 110,
              resumePromptMode: 'standard',
            },
          },
        },
      },
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('canonical turn cancellation also unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.cancelTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('drains the next row after a newer local turn end despite an older in-progress snapshot', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_000,
      pendingCount: 1,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    client.onUserMessage(() => {});
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    fetchSnapshotMock.mockResolvedValue({
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_500,
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await client.reconcilePendingQueueState({ force: true });

    const materialized = createProviderDeliveryMaterializeResult('turn-end-neighbor');
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        providerAction: 'send' as const,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId: 'turn-end-neighbor' });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      foregroundState: 'ready',
    }));
    nowSpy.mockRestore();
  });

  it.each([
    {
      label: 'an in-progress snapshot without an observation timestamp',
      initialObservedAt: 2_000,
      snapshotObservedAt: undefined,
      expectedForegroundState: 'ready',
    },
    {
      label: 'a genuinely newer in-progress snapshot',
      initialObservedAt: 1_000,
      snapshotObservedAt: 2_000,
      expectedForegroundState: 'active_unsteerable',
    },
  ] as const)('treats $label monotonically', async ({
    initialObservedAt,
    snapshotObservedAt,
    expectedForegroundState,
  }) => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: initialObservedAt,
      pendingCount: 1,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    client.onUserMessage(() => {});
    fetchSnapshotMock.mockResolvedValue({
      latestTurnStatus: 'in_progress',
      ...(snapshotObservedAt !== undefined
        ? { latestTurnStatusObservedAt: snapshotObservedAt }
        : {}),
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });
    await client.reconcilePendingQueueState({ force: true });

    const materialized = createProviderDeliveryMaterializeResult(`monotonic-${expectedForegroundState}`);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        providerAction: 'send' as const,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized' });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      foregroundState: expectedForegroundState,
    }));
  });

  it('wakes pending consumers on turn completion (metadata-updated)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    let woke = 0;
    client.on('metadata-updated', () => {
      woke += 1;
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a stale-empty pending count on turn completion (lost-nudge recovery)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    fetchSnapshotMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSnapshotMock).toHaveBeenCalled();
  });

  it('reports pending queue reconciliation changes when only the blocked count changes', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    fetchSnapshotMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 2,
        pendingBlockedCount: 1,
        pendingVersion: 7,
      },
    });

    await expect(client.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it('does not infer provider acceptance and re-enters the canonical claim owner', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 42 },
    });
    listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['delivering-local']);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      localId: null,
      didWrite: false,
      deferredReason: 'waiting_for_predecessor',
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
    });

    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ type: 'deferred', reason: 'waiting_for_predecessor' });
  });

  it('always requests the current canonical provider-delivery state', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: true,
    }));
  });
  it('ignores provider acceptance that is not tied to a canonical materialized claim', async () => {
    const infoSpy = vi.spyOn(logger, 'infoFile');
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    confirmProviderInputAccepted(client, 'prompt-late-seq');

    expect(hasProviderInputAcceptance(client, 'prompt-late-seq')).toBe(false);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('[pendingQueue] provider acceptance handoff', expect.objectContaining({
      sessionId: 's1', localId: 'prompt-late-seq', stage: 'accepted_observed', canonicalCustody: false,
      producerGeneration: expect.any(Number), sessionConnectionEpoch: expect.any(Number),
    }));
    expect(infoSpy).toHaveBeenCalledWith('[pendingQueue] provider acceptance handoff', expect.objectContaining({
      localId: 'prompt-late-seq', stage: 'canonical_custody_absent', canonicalCustody: false,
    }));
    logger.flushSync();
    expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('"localId":"prompt-late-seq","stage":"canonical_custody_absent"');

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-late-seq' });

    expect(hasProviderInputAcceptance(client, 'prompt-late-seq')).toBe(false);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'disconnected socket without retry qualification',
      localId: 'diagnostic-no-retry-socket',
      error: Object.assign(new Error('private socket detail'), { code: 'socket_not_connected', retryable: false }),
      failure: { kind: 'socket', code: 'socket_not_connected' },
    },
    {
      // A `forbidden` settlement is a lost publisher, covered under 'lost pending publisher'.
      name: 'recognized server refusal',
      localId: 'diagnostic-no-retry-server',
      error: new PendingQueueAcceptedSettlementError('transcript-conflict'),
      failure: { kind: 'server_ack', error: 'transcript-conflict' },
    },
    {
      name: 'unrecognized typed server value',
      localId: 'diagnostic-no-retry-server-unknown',
      error: new PendingQueueAcceptedSettlementError('private-unrecognized-server-value'),
      failure: { kind: 'unknown' },
    },
    {
      name: 'untyped failure',
      localId: 'diagnostic-no-retry-unknown',
      error: Object.assign(new Error('private-untyped-failure'), { code: 'private-unrecognized-code' }),
      failure: { kind: 'unknown' },
    },
  ])('retries an unresolved accepted settlement for $name without repeating provider input', async ({ localId, error, failure }) => {
    const infoSpy = vi.spyOn(logger, 'infoFile');
    const warningSpy = vi.spyOn(logger, 'warn');
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    vi.useFakeTimers();
    const retryAt = Date.now() + 120_000;
    const original = createProviderDeliveryMaterializeResult(localId);
    materializeNextMock.mockResolvedValue(original);
    listDeliveryStatusesMock.mockResolvedValue([{ localId, status: 'delivering' }]);
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(error);
    const providerEntry = vi.fn((message: unknown) => {
      expect(message).toEqual({ ...original.message.content.v, createdAt: 1000 });
      confirmProviderInputAccepted(client, localId);
    });
    client.onUserMessage(providerEntry);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized', localId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(infoSpy).toHaveBeenCalledWith('[pendingQueue] provider acceptance handoff', expect.objectContaining({
      sessionId: 's1', localId, stage: 'settlement_admitted', canonicalCustody: true,
      producerGeneration: expect.any(Number), sessionConnectionEpoch: expect.any(Number),
    }));
    expect(warningSpy).toHaveBeenCalledWith('[pendingQueue] accepted provider settlement remains unresolved', expect.objectContaining({
      sessionId: 's1', localId, attempt: 1, retryAfterMs: 120_000, willRetry: true,
      retryDisposition: 'same_operation_after_backoff', failure,
      producerGeneration: expect.any(Number), sessionConnectionEpoch: expect.any(Number),
    }));
    await vi.waitFor(() => {
      logger.flushSync();
      expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(`"failure":${JSON.stringify(failure)}`);
    });
    const fileLog = readFileSync(logger.getLogPath(), 'utf8');
    expect(fileLog).not.toContain('private socket detail');
    expect(fileLog).not.toContain('private-unrecognized-server-value');
    expect(fileLog).not.toContain('private-unrecognized-code');
    expect(fileLog).not.toContain('private-untyped-failure');
    expect(client.hasPendingProviderInputAcceptance(localId)).toBe(true);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({ type: 'no_pending' });
    expect(providerEntry).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledExactlyOnceWith({ socket: sessionSocketStub, sessionId: 's1', localId });
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false);
    expect(providerEntry).toHaveBeenCalledTimes(1);
  });

  it('logs once per held input when held provider custody stops materialization', async () => {
    const localId = 'held-custody-logged-once';
    const infoSpy = vi.spyOn(logger, 'infoFile');
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId));
    listDeliveryStatusesMock.mockResolvedValue([{ localId, status: 'delivering' }]);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    const heldLines = () => infoSpy.mock.calls.filter(([message]) => message === '[pendingQueue] materialization held by provider custody');

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({ type: 'no_pending' });
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({ type: 'no_pending' });

    expect(heldLines()).toEqual([['[pendingQueue] materialization held by provider custody', {
      sessionId: 's1', localId, providerInputOutcome: null, publisherRecovery: 'current',
      sessionConnectionEpoch: expect.any(Number),
    }]]);
    logger.flushSync();
    expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(`"localId":"${localId}","providerInputOutcome":null`);
  });

  it.each([true, false])('retries the original accepted settlement after a pre-emit socket drop recovers without another provider entry (didResolve=%s)', async (didResolve) => {
    const actualTransport = await vi.importActual<typeof import('./pendingQueueV2Transport')>('./pendingQueueV2Transport');
    const localId = 'pre-emit-drop-exact-local';
    const original = createProviderDeliveryMaterializeResult(localId);
    const committed = {
      id: 'committed-pre-emit-drop',
      seq: 83,
      localId,
      messageRole: original.message.messageRole,
      content: original.message.content,
      createdAt: original.message.createdAt,
      updatedAt: original.message.updatedAt,
    };
    const transcriptCommit = vi.fn();
    const settlementAck = vi.fn(() => {
      if (didResolve) transcriptCommit();
      return { ok: true, didResolve, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3, message: committed };
    });
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 }, {
      sessionSocketEmitWithAck: (event) => event === 'pending-delivery-accepted-v1' ? settlementAck() : { ok: true },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(original);
    let dropBeforeEmit = true;
    resolveAcceptedPendingDeliveryMock.mockImplementation((params: Parameters<typeof actualTransport.resolveAcceptedPendingQueueV2Delivery>[0]) => {
      if (!dropBeforeEmit) return actualTransport.resolveAcceptedPendingQueueV2Delivery(params);
      dropBeforeEmit = false;
      // Preserve the real accepted adapter and local ACK check. Only the socket boundary
      // drops, then recovers before the existing owner classifies the rejection.
      params.socket.connected = false;
      const operation = actualTransport.resolveAcceptedPendingQueueV2Delivery(params);
      params.socket.connected = true;
      return operation;
    });
    const providerEntry = vi.fn((message: unknown) => {
      expect(message).toEqual({ ...original.message.content.v, createdAt: 1000 });
      confirmProviderInputAccepted(client, localId);
    });
    client.onUserMessage(providerEntry);
    const warningSpy = vi.spyOn(logger, 'warn');
    vi.useFakeTimers();
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    await vi.advanceTimersByTimeAsync(0);
    expect(warningSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      localId, attempt: 1, retryAfterMs: 1000, willRetry: true,
    }));
    expect(settlementAck).not.toHaveBeenCalled();
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    for (const [request] of resolveAcceptedPendingDeliveryMock.mock.calls) {
      expect(request).toEqual({ socket: sessionSocketStub, sessionId: 's1', localId });
    }
    expect(settlementAck).toHaveBeenCalledTimes(1);
    expect(transcriptCommit).toHaveBeenCalledTimes(didResolve ? 1 : 0);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false);
    expect(client.hasPendingProviderInputAcceptance(localId)).toBe(true);
    expect(client.getCommittedUserMessageSeq(localId)).toBe(83);
    expect(providerEntry).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('resolves server-owned provider delivery after provider acceptance', async () => {
    vi.spyOn(logger, 'infoFile').mockImplementation(() => { throw new Error('diagnostic sink unavailable'); });
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'new-server-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-new-server',
        seq: 43,
        localId: 'new-server-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'new server prompt' },
            localId: 'new-server-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect((result as any).deliveryState).toEqual(deliveryState);

    confirmProviderInputAccepted(client, 'new-server-local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'new-server-local',
    });
    expect(hasProviderInputAcceptance(client, 'new-server-local')).toBe(true);
  });

  it('retries only the exact accepted settlement at typed 503 delay without changing socket health', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError(
        'transaction-unavailable',
        1_250,
        'req-accepted-busy',
      ))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'watermark-held-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-watermark-held',
        seq: 43,
        localId: 'watermark-held-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'watermark held prompt' },
            localId: 'watermark-held-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'watermark-held-local',
      deliveryState,
    });

    vi.useFakeTimers();
    catchUpMock.mockClear();
    fetchSnapshotMock.mockClear();
    listProviderDeliveryLocalIdsMock.mockClear();
    listDeliveryStatusesMock.mockClear();
    enqueueSessionTurnMock.mockClear();
    supervisorReportProbeResultMock.mockClear();
    sessionSocketStub?.connect.mockClear();
    sessionSocketStub?.disconnect.mockClear();
    sessionSocketStub?.close.mockClear();
    userSocketStub?.connect.mockClear();
    userSocketStub?.disconnect.mockClear();
    userSocketStub?.close.mockClear();

    confirmProviderInputAccepted(client, 'watermark-held-local');
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();
    expect(userSocketStub?.connect).not.toHaveBeenCalled();
    expect(userSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(userSocketStub?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_249);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenLastCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'watermark-held-local',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();

  });

  it.each([
    { error: new PendingQueueAcceptedSettlementError('transaction-unavailable', 1250), delayMs: 1250 },
    { error: createSocketAckError({ code: 'socket_not_connected', event: 'pending-delivery-accepted-v1', message: 'disconnected before emit' }), delayMs: 1000 },
  ])('abandons the operation-local accepted settlement retry when its originating runtime is replaced %#', async ({ error, delayMs }) => {
    const warningSpy = vi.spyOn(logger, 'warn');
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('runtime-fenced-settlement'));
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'runtime-fenced-settlement');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ willRetry: true, retryAfterMs: delayMs }));

    client.beginRuntimeTermination();
    await vi.advanceTimersByTimeAsync(delayMs);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('runtime-fenced-settlement')).toBe(true);
  });

  it('resumes unfinished accepted settlement when a replacement provider producer binds', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    const observe = client.bindProviderInputOutcomeProducer({ providerId: 'codex', mode: 'unifiedTerminal', matchesCurrentSession: () => true });
    vi.useFakeTimers();
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('rebound-settlement', 2));
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(Object.assign(new Error('ack lost'), { code: 'socket_ack_timeout', retryable: true }));
    const delivered = vi.fn();
    client.onUserMessage(delivered);
    await client.materializeNextPendingMessageSafely();
    observe({ kind: 'accepted', localId: 'rebound-settlement' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    client.bindProviderInputOutcomeProducer({ providerId: 'codex', mode: 'unifiedTerminal', matchesCurrentSession: () => true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(client.hasCanonicalPendingProviderInputDelivery('rebound-settlement')).toBe(false);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('rejoins the same operation after a socket ACK timeout without granting unrelated wakes retry authority', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('ack-timeout-settlement'));
    const timeoutError = Object.assign(new Error('socket acknowledgement timed out'), {
      code: 'socket_ack_timeout' as const,
      retryable: true as const,
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
        message: {
          ...createProviderDeliveryMaterializeResult('ack-timeout-settlement').message,
          id: 'committed-ack-timeout-settlement',
          seq: 43,
          deliveryState: null,
        },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'ack-timeout-settlement');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'unrelated-pending-wake-during-ack-timeout',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('ack-timeout-settlement')).toBe(false);
  });

  it('continues exact accepted settlement after repeated response loss without reconnecting', async () => {
    const warningSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    warningSpy.mockImplementationOnce(() => { throw new Error('diagnostic sink unavailable'); });
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('bounded-rejoin-local'));
    const timeoutError = Object.assign(new Error('socket acknowledgement timed out'), {
      code: 'socket_ack_timeout' as const,
      retryable: true as const,
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
        message: {
          ...createProviderDeliveryMaterializeResult('bounded-rejoin-local').message,
          id: 'committed-bounded-rejoin-local',
          seq: 43,
          deliveryState: null,
        },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'bounded-rejoin-local');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'bounded-rejoin-wake',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('bounded-rejoin-local')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(3);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('bounded-rejoin-local')).toBe(true);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(4);
    for (const [request] of resolveAcceptedPendingDeliveryMock.mock.calls) {
      expect(request).toEqual({ socket: sessionSocketStub, sessionId: 's1', localId: 'bounded-rejoin-local' });
    }
    expect((client as any).canonicalPendingDeliveryByLocalId.has('bounded-rejoin-local')).toBe(false);
    expect(hasProviderInputAcceptance(client, 'bounded-rejoin-local')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      sessionId: 's1',
      localId: 'bounded-rejoin-local',
      attempt: 3,
      retryAfterMs: 4_000,
      willRetry: true,
      retryDisposition: 'same_operation_after_backoff',
      failure: { kind: 'socket', code: 'socket_ack_timeout' },
      errorValuesOmitted: true,
    }));
  });

  it('caps accepted settlement backoff and cancels it on close without another provider input', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('capped-close-settlement'));
    resolveAcceptedPendingDeliveryMock.mockRejectedValue(
      new PendingQueueAcceptedSettlementError('transaction-unavailable', 120_000),
    );
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'capped-close-settlement');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    (client as any).rpcLifecycleRegistrations.splice(0);
    const close = client.close();
    await vi.advanceTimersByTimeAsync(0);
    await close;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('retries an uncertain accepted-settlement internal failure with correlated diagnostics and no socket teardown', async () => {
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('generic-500-local'))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-queued-local', 4));
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(
      new PendingQueueAcceptedSettlementError('internal', undefined, 'req-post-callback-500'),
    ).mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
      message: { ...createProviderDeliveryMaterializeResult('generic-500-local').message, id: 'committed', seq: 7 },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'generic-500-local',
    });

    vi.useFakeTimers();
    catchUpMock.mockClear();
    fetchSnapshotMock.mockClear();
    listProviderDeliveryLocalIdsMock.mockClear();
    listDeliveryStatusesMock.mockClear();
    enqueueSessionTurnMock.mockClear();
    supervisorReportProbeResultMock.mockClear();
    sessionSocketStub?.connect.mockClear();
    sessionSocketStub?.disconnect.mockClear();
    sessionSocketStub?.close.mockClear();

    confirmProviderInputAccepted(client, 'generic-500-local');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledWith(
      '[pendingQueue] accepted provider delivery resolution failed',
      expect.objectContaining({
        sessionId: 's1',
        localId: 'generic-500-local',
        error: expect.objectContaining({
          code: 'pending_queue_accepted_settlement_failed',
          settlementError: 'internal',
          correlationId: 'req-post-callback-500',
        }),
      }),
    );
    expect(client.hasCanonicalPendingProviderInputDelivery('generic-500-local')).toBe(false);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();
    await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
      type: 'materialized', localId: 'later-queued-local',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('delivers provider-claimed pending rows directly without a committed transcript seq', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt' },
          localId: 'claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-claimed-provider-local',
        seq: 43,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    confirmProviderInputAccepted(client, 'claimed-provider-local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'claimed-provider-local',
    });
    expect(hasProviderInputAcceptance(client, 'claimed-provider-local')).toBe(true);
    expect(client.getCommittedUserMessageSeq('claimed-provider-local')).toBe(43);
  });


  it('waits for in-flight accepted pending-delivery resolution before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-drain-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-drain-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before close' },
            localId: 'close-drain-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-drain-provider-local',
      deliveryState,
    });

    const acceptedWrite = createDeferred<void>();
    resolveAcceptedPendingDeliveryMock.mockImplementationOnce(async () => {
      await acceptedWrite.promise;
      return {
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
        message: {
          id: 'm-close-drain-provider-local',
          seq: 43,
          localId: 'close-drain-provider-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'claimed provider prompt before close' },
              localId: 'close-drain-provider-local',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      };
    });

    confirmProviderInputAccepted(client, 'close-drain-provider-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    let closeSettled = false;
    const closePromise = client.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeSettled).toBe(false);

    acceptedWrite.resolve();
    await closePromise;
    expect(closeSettled).toBe(true);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('does not block provider-accepted pending delivery on close when accepted resolution is still failing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-accepted-retry-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-accepted-retry-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'accepted prompt with temporary resolution failure' },
            localId: 'close-accepted-retry-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted resolution failure'))
      .mockRejectedValueOnce(new Error('still temporarily unavailable'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-accepted-retry-local',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'close-accepted-retry-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    await client.close();

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('blocks unresolved provider-claimed pending deliveries before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before runner exit' },
            localId: 'close-block-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-provider-local',
      deliveryState,
    });

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks unresolved provider-custody rows discovered from durable state during close', async () => {
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['close-durable-provider-local']);
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 2,
      },
    });

    try {
      await client.close();

      expect(listProviderDeliveryLocalIdsMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
      });
      expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
        localId: 'close-durable-provider-local',
        reason: 'runtime_disposed_before_delivery',
      });
      expect(debugSpy.mock.calls.some(([message, payload]) =>
        String(message) === '[pendingQueue] provider delivery block succeeded'
        && (payload as any)?.sessionId === 's1'
        && (payload as any)?.localId === 'close-durable-provider-local'
        && (payload as any)?.reason === 'runtime_disposed_before_delivery'
      )).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('blocks delivered provider-claimed pending rows before closing when materialization omits delivery state', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-legacy-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-legacy-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
            localId: 'close-block-legacy-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-legacy-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
          localId: 'close-block-legacy-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-legacy-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks delivered uncommitted provider-claimed pending rows whose materialization includes an opaque id', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-opaque-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-pending-materialization-id',
        seq: null,
        localId: 'close-block-opaque-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
            localId: 'close-block-opaque-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-opaque-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
          localId: 'close-block-opaque-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-opaque-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('normalizes contradictory resolved provider state on delivered uncommitted provider claims', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-resolved-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-resolved-provider-materialization-id',
        seq: null,
        localId: 'close-block-resolved-provider-local',
        messageRole: 'user',
        deliveryState: { mode: 'provider' as const, unresolved: false },
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
            localId: 'close-block-resolved-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const normalizedDeliveryState = { mode: 'provider', unresolved: true };
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-resolved-provider-local',
      seq: null,
      deliveryState: normalizedDeliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
          localId: 'close-block-resolved-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-resolved-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('uses the materialization ack localId for provider-claimed rows whose nested message omits it', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'top-level-claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: null,
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'top-level-claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
          localId: 'top-level-claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-top-level-claimed-provider-local',
        seq: 44,
        localId: 'top-level-claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            localId: 'top-level-claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    confirmProviderInputAccepted(client, 'top-level-claimed-provider-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'top-level-claimed-provider-local',
    });
    expect(hasProviderInputAcceptance(client, 'top-level-claimed-provider-local')).toBe(true);
    expect(client.getCommittedUserMessageSeq('top-level-claimed-provider-local')).toBe(44);
  });

  it('blocks malformed provider-delivery materialization metadata instead of dropping the row locally', async () => {
    const localId = 'malformed-provider-delivery-local';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: 'user',
        deliveryStateMalformed: true,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'malformed provider delivery metadata prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(delivered).toEqual([]);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId,
      reason: 'unknown',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('delivers encrypted provider-claimed pending rows even when server role metadata is missing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const localId = 'encrypted-claimed-provider-local';
    const encryptionKey = new Uint8Array(32);
    const client = await createClient({
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: null,
        deliveryState,
        content: {
          t: 'encrypted',
          c: encodeBase64(encrypt(encryptionKey, 'legacy', {
            role: 'user',
            content: { type: 'text', text: 'encrypted claimed provider prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          })),
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'encrypted claimed provider prompt' },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it.each([
    { configured: undefined, timeoutMs: 120_000 },
    { configured: '1000', timeoutMs: 1_000 },
  ])('expires unresolved custody after $timeoutMs ms and permits a later claim', async ({ configured, timeoutMs }) => {
    vi.stubEnv('HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS', configured);
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 2, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    providerInputOutcomeObserver(client);
    vi.useFakeTimers();
    const delivered: string[] = [];
    client.onUserMessage((message) => { if (message.localId) delivered.push(message.localId); });
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('watchdog-original', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-after-watchdog', 4));
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    await client.materializeNextPendingMessageSafely();
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok', sessionId: 's1', localId: 'watchdog-original', reason: 'delivery_outcome_uncertain',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
      type: 'materialized', localId: 'later-after-watchdog',
    });
    expect(delivered).toEqual(['watchdog-original', 'later-after-watchdog']);
    expect(materializeNextMock.mock.calls[1]?.[0]).toMatchObject({ heldLocalIds: ['watchdog-original'] });
    expect(client.hasCanonicalPendingProviderInputDelivery('watchdog-original')).toBe(true);
    confirmProviderInputAccepted(client, 'watchdog-original');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.hasPendingProviderInputAcceptance('watchdog-original')).toBe(true);
    expect(client.hasCanonicalPendingProviderInputDelivery('watchdog-original')).toBe(false);
  });

  it('allows exact B past held A without redispatching retained B or trusting an empty count', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('held-A', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult(' B ', 3));
    await client.materializeNextPendingMessageSafely();
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    expect(client.shouldAttemptPendingMaterialization({ requestedLocalId: ' B ' })).toBe(true);
    // A stale aggregate count is not an authoritative answer to an exact operation.
    (client as any).pendingQueueState = { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 };
    await expect(client.materializeNextPendingMessageSafely({ requestedLocalId: ' B ' })).resolves.toMatchObject({
      type: 'materialized', localId: ' B ',
    });
    expect(materializeNextMock.mock.calls[1]?.[0]).toMatchObject({ requestedLocalId: ' B ', heldLocalIds: ['held-A'] });
    expect(client.shouldAttemptPendingMaterialization({ requestedLocalId: ' B ' })).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({ requestedLocalId: ' B ' })).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('keeps accepted custody non-blocking while its settlement is still in flight', async () => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 2, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    const settlement = createDeferred<{ didResolve: boolean }>();
    resolveAcceptedPendingDeliveryMock.mockReturnValueOnce(settlement.promise);
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('accepted-in-flight', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-before-settlement', 3));
    try {
      await client.materializeNextPendingMessageSafely();
      confirmProviderInputAccepted(client, 'accepted-in-flight');
      expect(client.shouldAttemptPendingMaterialization()).toBe(true);
      await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
        type: 'materialized', localId: 'later-before-settlement',
      });
      expect(materializeNextMock.mock.calls[1]?.[0]).toMatchObject({ heldLocalIds: ['accepted-in-flight'] });
      expect(client.hasCanonicalPendingProviderInputDelivery('accepted-in-flight')).toBe(true);
    } finally {
      settlement.resolve({ didResolve: true });
    }
  });

  it.each(['accepted', 'termination', 'close'] as const)(
    'cancels the custody watchdog after %s', async (terminal) => {
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
      await waitForCurrentPendingInputContract(client);
      providerInputOutcomeObserver(client);
      vi.useFakeTimers();
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('watchdog-cancelled', 2));
      await client.materializeNextPendingMessageSafely();
      if (terminal === 'accepted') {
        resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({ didResolve: false });
        confirmProviderInputAccepted(client, 'watchdog-cancelled');
      } else if (terminal === 'termination') client.beginRuntimeTermination();
      else await client.close();
      blockPendingDeliveryMock.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
    },
  );

  it('clears accepted canonical pending delivery so later pending rows can materialize', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-provider-1',
          seq: 51,
          localId: 'provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first prompt' },
              localId: 'provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-provider-2',
          seq: 52,
          localId: 'provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second prompt' },
              localId: 'provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    confirmProviderInputAccepted(client, 'provider-m1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retains reserved custody after server-row absence until accepted exact committed proof releases the later row', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const providerInvocations: string[] = [];
    client.onUserMessage((message) => {
      if (message.localId) providerInvocations.push(message.localId);
    });
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('manual-handled-local', 2))
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult('later-local', 4),
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4 },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'manual-handled-local',
    });
    expect(providerInvocations).toEqual(['manual-handled-local']);

    // Absence could result from manual handling, but the snapshot carries no exact receipt.
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'later-local', status: 'queued' },
    ]);
    await client.reconcilePendingQueueState({ force: true });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('manual-handled-local')).toBe(true);
    expect(hasProviderInputAcceptance(client, 'manual-handled-local')).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(providerInvocations).toEqual(['manual-handled-local']);

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({ didResolve: false });
    confirmProviderInputAccepted(client, 'manual-handled-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('manual-handled-local')).toBe(true);
    triggerCommittedUserMessage({ seq: 75, localId: 'manual-handled-local' });
    expect((client as any).canonicalPendingDeliveryByLocalId.has('manual-handled-local')).toBe(false);
    expect(client.getCommittedUserMessageSeq('manual-handled-local')).toBe(75);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'later-local',
    });

    expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(2);
    expect(listDeliveryStatusesMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localIds: ['manual-handled-local'],
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect(providerInvocations).toEqual(['manual-handled-local', 'later-local']);
    expect(hasProviderInputAcceptance(client, 'manual-handled-local')).toBe(true);
  });

  it('retires an exact discarded server row without manufacturing provider input or acceptance', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const providerInvocations: string[] = [];
    client.onUserMessage((message) => {
      if (message.localId) providerInvocations.push(message.localId);
    });
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('discarded-local', 2))
      .mockResolvedValueOnce({
        didMaterialize: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(providerInvocations).toEqual(['discarded-local']);
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'discarded-local', status: 'discarded' },
    ]);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(providerInvocations).toEqual(['discarded-local']);
    expect(hasProviderInputAcceptance(client, 'discarded-local')).toBe(false);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('discarded-local')).toBe(false);
  });

  it.each(['queued', 'delivering'] as const)(
    'retains exact local custody while the server row remains %s',
    async (status) => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: { deliveredUserMessageSeqV1: 0 },
      });
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(`unresolved-${status}`, 2));

      await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      listDeliveryStatusesMock.mockResolvedValueOnce([
        { localId: `unresolved-${status}`, status },
      ]);

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
        type: 'no_pending',
      });

      expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
      expect((client as any).canonicalPendingDeliveryByLocalId.has(`unresolved-${status}`)).toBe(true);
    },
  );

  it('retains exact local custody when the bounded status reconciliation fails', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('status-network-failure', 2));

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    listDeliveryStatusesMock.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('status-network-failure')).toBe(true);
  });

  it('does not retire exact local custody from a terminal status belonging to another localId', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('exact-live-local', 2));

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'wrong-terminal-local', status: 'discarded' },
      { localId: 'exact-live-local', status: 'delivering' },
    ]);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('exact-live-local')).toBe(true);
  });

  it('retains canonical ownership and progress when accepted delivery is a server no-op', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 3,
      },
    });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'provider-noop', status: 'blocked' },
    ]);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'provider-noop',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'provider-noop',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'provider no-op prompt' },
            localId: 'provider-noop',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-noop',
      deliveryState,
    });
    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-noop')).toBe(true);

    confirmProviderInputAccepted(client, 'provider-noop');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-noop')).toBe(true);
  });

  it('does not grant a delivery-status snapshot retry authority after a settlement no-op', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('non-authoritative-status'));
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    listDeliveryStatusesMock.mockRejectedValueOnce(
      new Error('Invalid pending queue delivery status projection'),
    );

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'non-authoritative-status');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('non-authoritative-status')).toBe(true);
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
  });

  it('retains an accepted claim after a settlement no-op without starting an independent absence transaction', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'provider-idempotent',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'provider-idempotent',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'provider idempotent prompt' },
            localId: 'provider-idempotent',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'provider-idempotent');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-idempotent')).toBe(true);
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
  });

  it('delivers later pending input after a permanent accepted-settlement failure', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary resolution failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    listDeliveryStatusesMock.mockResolvedValue([
      { localId: 'retry-provider-m1', status: 'delivering' },
    ]);
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-provider-1',
          seq: 61,
          localId: 'retry-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first retry prompt' },
              localId: 'retry-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-provider-2',
          seq: 62,
          localId: 'retry-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second retry prompt' },
              localId: 'retry-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-provider-m1',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'retry-provider-m1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized', localId: 'retry-provider-m2',
    });
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a newer pending-change wake retry accepted-delivery settlement', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-on-pending-change'));
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted-resolution failure'))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'retry-on-pending-change');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'accepted-resolution-pending-change',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-on-pending-change')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not let turn end retry a live didResolve false settlement', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-noop-on-turn-end'));
    resolveAcceptedPendingDeliveryMock
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
      })
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
      });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'retry-noop-on-turn-end', status: 'blocked' },
    ]);

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'retry-noop-on-turn-end');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-noop-on-turn-end')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('re-drives exact provider acceptance after reconnect when acceptance arrived while disconnected', async () => {
    const infoSpy = vi.spyOn(logger, 'infoFile');
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-on-reconnect'));
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    if (!sessionSocketStub) throw new Error('missing session socket');
    sessionSocketStub.connected = false;
    confirmProviderInputAccepted(client, 'retry-on-reconnect');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-on-reconnect')).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('[pendingQueue] provider acceptance handoff', expect.objectContaining({
      sessionId: 's1', localId: 'retry-on-reconnect', stage: 'authority_unavailable', canonicalCustody: true,
    }));

    if (!supervisorOnConnected) throw new Error('missing supervised reconnect callback');
    sessionSocketStub.connected = true;
    await supervisorOnConnected();

    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-on-reconnect')).toBe(false);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a wake consumed by a successful resolution for a later failed acceptance', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    const firstResolution = createDeferred<any>();
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('wake-success-first', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('wake-failure-second', 4));
    resolveAcceptedPendingDeliveryMock
      .mockImplementationOnce(() => firstResolution.promise)
      .mockRejectedValueOnce(new Error('later accepted-resolution failure'))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 6 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'wake-success-first');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'wake-during-successful-resolution',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    firstResolution.resolve({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has('wake-success-first') === false);

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'wake-failure-second');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('wake-failure-second')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retains accepted settlement identity after not-found without holding the later row', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock.mockRejectedValue(
      new PendingQueueAcceptedSettlementError('not-found'),
    );
    fetchSnapshotMock.mockResolvedValue({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-stale-accepted-provider-1',
          seq: 71,
          localId: 'stale-accepted-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first stale accepted prompt' },
              localId: 'stale-accepted-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-stale-accepted-provider-2',
          seq: 72,
          localId: 'stale-accepted-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale accepted claim' },
              localId: 'stale-accepted-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-accepted-provider-m1',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'stale-accepted-provider-m1');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId: 'stale-accepted-provider-m2' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('stale-accepted-provider-m1')).toBe(true);
    expect(hasProviderInputAcceptance(client, 'stale-accepted-provider-m1')).toBe(true);
    triggerCommittedUserMessage({ seq: 71, localId: 'stale-accepted-provider-m1' });
    expect(client.getCommittedUserMessageSeq('stale-accepted-provider-m1')).toBe(71);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('stale-accepted-provider-m1')).toBe(false);
    expect(hasProviderInputAcceptance(client, 'stale-accepted-provider-m1')).toBe(true);
  });

  it('retires an accepted-delivery claim only from the exact committed replay identity and seq', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(' replay-proof-local '));
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-replay-proof',
        seq: 73,
        localId: ' replay-proof-local ',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'replayed' } } },
        createdAt: 1_000,
        updatedAt: 1_001,
        deliveryState: null,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, ' replay-proof-local ');
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(' replay-proof-local ') === false);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(hasProviderInputAcceptance(client, ' replay-proof-local ')).toBe(true);
    expect(client.getCommittedUserMessageSeq(' replay-proof-local ')).toBe(73);
    expect(client.getCommittedUserMessageSeq('replay-proof-local')).toBeNull();
  });

  it('retires accepted canonical custody when the exact committed transcript arrives after settlement response loss', async () => {
    const localId = 'accepted-response-loss-transcript-proof';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('next-after-transcript-proof'));
    resolveAcceptedPendingDeliveryMock.mockRejectedValue(
      new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250),
    );

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
    });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, localId);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    triggerCommittedUserMessage({ seq: 73, localId: 'neighbor-transcript-row' });
    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(true);

    triggerCommittedUserMessage({ seq: 74, localId });

    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(false);
    expect(client.getCommittedUserMessageSeq(localId)).toBe(74);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'next-after-transcript-proof',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('blocks server-owned provider delivery after a terminal pre-write payload rejection', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-too-large-provider-1',
          seq: 71,
          localId: 'too-large-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'oversized prompt' },
              localId: 'too-large-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-too-large-provider-2',
          seq: 72,
          localId: 'too-large-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt' },
              localId: 'too-large-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.blockPendingMessageDelivery({
      localIds: ['too-large-provider-m1'],
      reason: 'payload_too_large',
    })).resolves.toBe(true);

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'too-large-provider-m1',
      reason: 'payload_too_large',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('allows a later exact action after an uncertain claim is durably blocked while retaining late acceptance identity', async () => {
    const uncertainLocalId = 'uncertain-blocked-original';
    const replacementLocalId = 'uncertain-send-as-new-replacement';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult(uncertainLocalId, 2),
        pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 2 },
      })
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult(replacementLocalId, 4),
        pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 4 },
      });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
      message: {
        id: `message-${uncertainLocalId}`,
        seq: 91,
        localId: uncertainLocalId,
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `prompt ${uncertainLocalId}` } } },
        createdAt: 1_000,
        updatedAt: 1_001,
        deliveryState: null,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: uncertainLocalId,
    });
    await expect(client.blockPendingMessageDelivery({
      localIds: [uncertainLocalId],
      reason: 'ambiguous_terminal_delivery',
    })).resolves.toBe(true);

    expect((client as any).canonicalPendingDeliveryByLocalId.has(uncertainLocalId)).toBe(true);
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: replacementLocalId,
    });

    confirmProviderInputAccepted(client, uncertainLocalId);
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(uncertainLocalId) === false);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: uncertainLocalId,
    });
    expect((client as any).canonicalPendingDeliveryByLocalId.has(replacementLocalId)).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a proven pre-acceptance rejection when a later ambiguous terminal report races it', async () => {
    const localId = 'proven-rejection-before-ambiguous-terminal';
    const firstBlock = createDeferred<{
      pendingQueueState: {
        known: true;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
      };
    }>();
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId));
    blockPendingDeliveryMock.mockImplementationOnce(() => firstBlock.promise);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
    });

    const provenRejection = client.blockPendingMessageDelivery({
      localIds: [localId],
      reason: 'provider_rejected_before_acceptance',
    });
    await waitUntil(() => blockPendingDeliveryMock.mock.calls.length === 1);
    const ambiguousTerminal = client.blockPendingMessageDelivery({
      localIds: [localId],
      reason: 'ambiguous_terminal_delivery',
    });

    firstBlock.resolve({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });

    await expect(provenRejection).resolves.toBe(true);
    await expect(ambiguousTerminal).resolves.toBe(false);
    expect(blockPendingDeliveryMock).toHaveBeenCalledExactlyOnceWith({
      token: 'tok',
      sessionId: 's1',
      localId,
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)(
    'retains the exact live provider claim through reversible %s blocking so late acceptance settles the row',
    async (reason) => {
      const localId = `reversible-${reason}`;
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: { deliveredUserMessageSeqV1: 0 },
      });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId));
      blockPendingDeliveryMock.mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
      });
      resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
        message: {
          id: `message-${localId}`,
          seq: 91,
          localId,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `prompt ${localId}` } } },
          createdAt: 1_000,
          updatedAt: 1_001,
          deliveryState: null,
        },
      });

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
        type: 'materialized',
        localId,
      });
      await expect(client.blockPendingMessageDelivery({ localIds: [localId], reason })).resolves.toBe(true);

      expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
        localId,
        reason,
      });
      expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(true);
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);

      confirmProviderInputAccepted(client, localId);
      await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
      await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(localId) === false);

      expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
        socket: sessionSocketStub,
        sessionId: 's1',
        localId,
      });
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { source: 'pre-effect', reason: 'provider_unavailable_before_acceptance' as const },
    { source: 'watchdog', reason: 'delivery_outcome_uncertain' as const },
  ])('releases local custody after a failed $source block and retries the original reason', async ({ source, reason }) => {
    vi.stubEnv('HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS', '1000');
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 2, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    providerInputOutcomeObserver(client);
    vi.useFakeTimers();
    const localId = 'failed-block-original';
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId, 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-after-failed-block', 3));
    blockPendingDeliveryMock
      .mockRejectedValueOnce(new Error('block response lost'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 4 },
      });
    await client.materializeNextPendingMessageSafely();
    if (source === 'watchdog') await vi.advanceTimersByTimeAsync(1_000);
    else await client.blockPendingMessageDelivery({ localIds: [localId], reason, providerEffect: 'none' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
      type: 'materialized', localId: 'later-after-failed-block',
    });
    confirmProviderInputAccepted(client, 'later-after-failed-block');
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(blockPendingDeliveryMock.mock.calls.map(([request]) => request)).toEqual([
      { token: 'tok', sessionId: 's1', localId, reason },
      { token: 'tok', sessionId: 's1', localId, reason },
    ]);
    confirmProviderInputAccepted(client, localId);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false);
  });

  it.each([
    ['blocked', 'late acceptance'], ['blocked', 'close'],
    ['resent_as_new', 'late acceptance'], ['resent_as_new', 'close'],
    ['dismissed_uncertain', 'late acceptance'], ['dismissed_uncertain', 'close'],
  ] as const)('releases server-%s custody immediately through %s without another outcome write', async (serverOutcome, continuation) => {
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 2, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    providerInputOutcomeObserver(client);
    vi.useFakeTimers();
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('server-blocked-original', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-after-server-block', 3));
    await client.materializeNextPendingMessageSafely();
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    listDeliveryStatusesMock.mockResolvedValue([{ localId: 'server-blocked-original',
      ...(serverOutcome === 'blocked' ? { status: 'blocked' } : { status: 'discarded', discardedReason: serverOutcome }),
    }]);
    const wake = vi.fn();
    client.on('metadata-updated', wake);
    await client.reconcilePendingQueueState({ force: true });
    expect(wake).toHaveBeenCalled();
    expect(listDeliveryStatusesMock).toHaveBeenLastCalledWith({ token: 'tok', sessionId: 's1', localIds: ['server-blocked-original'] });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
      type: 'materialized', localId: 'later-after-server-block',
    });
    expect(materializeNextMock.mock.calls[1]?.[0]).toMatchObject({ heldLocalIds: ['server-blocked-original'] });
    confirmProviderInputAccepted(client, 'later-after-server-block');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
    expect(client.hasCanonicalPendingProviderInputDelivery('server-blocked-original')).toBe(true);
    if (continuation === 'close') {
      await client.close();
      expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
      return;
    }
    confirmProviderInputAccepted(client, 'server-blocked-original');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId: 'server-blocked-original' }));
    expect(client.hasCanonicalPendingProviderInputDelivery('server-blocked-original')).toBe(false);
  });

  it.each(['provider_unavailable_before_acceptance', 'invalid_prompt_text'] as const)(
    'preserves the original failed %s block when closing', async (reason) => {
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('close-original-block', 2));
      blockPendingDeliveryMock
        .mockRejectedValueOnce(new Error('first block failed'))
        .mockRejectedValueOnce(new Error('canonical close block failed'))
        .mockResolvedValueOnce({});
      listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['close-original-block']);
      await client.materializeNextPendingMessageSafely();
      await client.blockPendingMessageDelivery({ localIds: ['close-original-block'], reason, providerEffect: 'none' });
      await client.close();
      expect(blockPendingDeliveryMock.mock.calls.map(([request]) => request)).toEqual([
        { token: 'tok', sessionId: 's1', localId: 'close-original-block', reason },
        { token: 'tok', sessionId: 's1', localId: 'close-original-block', reason },
        { token: 'tok', sessionId: 's1', localId: 'close-original-block', reason },
      ]);
    },
  );

  it.each(['pre-effect block', 'watchdog block', 'accepted failure', 'accepted no-op'] as const)(
    'retries a failed %s within 120 seconds with a longer configured watchdog', async (outcome) => {
      vi.stubEnv('HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS', '300000');
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 1, pendingVersion: 1 });
      await waitForCurrentPendingInputContract(client);
      providerInputOutcomeObserver(client);
      vi.useFakeTimers();
      const localId = 'long-watchdog-retry';
      const delivered = vi.fn();
      client.onUserMessage(delivered);
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId, 2));
      await client.materializeNextPendingMessageSafely();
      const isAccepted = outcome === 'accepted failure' || outcome === 'accepted no-op';
      if (isAccepted) {
        if (outcome === 'accepted failure') resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(new Error('settlement failed'));
        else resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({ didResolve: false });
        confirmProviderInputAccepted(client, localId);
      } else {
        blockPendingDeliveryMock.mockRejectedValueOnce(new Error('block failed'));
        if (outcome === 'pre-effect block') {
          await client.blockPendingMessageDelivery({ localIds: [localId], reason: 'provider_unavailable_before_acceptance', providerEffect: 'none' });
        } else {
          await vi.advanceTimersByTimeAsync(299_999);
          expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
        }
      }
      await vi.advanceTimersByTimeAsync(0);
      const writes = isAccepted ? resolveAcceptedPendingDeliveryMock : blockPendingDeliveryMock;
      expect(writes).toHaveBeenCalledTimes(1);
      expect(client.shouldAttemptPendingMaterialization()).toBe(true);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(writes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a rejected-before-effect outcome after not-found while later input proceeds', async () => {
    vi.stubEnv('HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS', '1000');
    const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 2, pendingVersion: 1 });
    await waitForCurrentPendingInputContract(client);
    const observe = client.bindProviderInputOutcomeProducer({ providerId: 'codex', mode: 'unifiedTerminal', matchesCurrentSession: () => true });
    vi.useFakeTimers();
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('rejected-block-not-found', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('later-after-rejection', 3));
    blockPendingDeliveryMock.mockRejectedValueOnce(createPendingDeliveryHttpError(404, 'not-found')).mockResolvedValueOnce({});
    await client.materializeNextPendingMessageSafely();
    observe({ kind: 'rejected_before_effect', localId: 'rejected-block-not-found', reason: 'provider_rejected_before_acceptance' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({ type: 'materialized', localId: 'later-after-rejection' });
    await vi.advanceTimersByTimeAsync(1_000);
    const originalWrites = blockPendingDeliveryMock.mock.calls.map(([request]) => request).filter((request) => request.localId === 'rejected-block-not-found');
    expect(originalWrites).toEqual([
      { token: 'tok', sessionId: 's1', localId: 'rejected-block-not-found', reason: 'provider_rejected_before_acceptance' },
      { token: 'tok', sessionId: 's1', localId: 'rejected-block-not-found', reason: 'provider_rejected_before_acceptance' },
    ]);
  });

  it('does not use turn-end catch-up as a hidden transcript queue for canonical pending deliveries', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    // The provider-delivery row is still delivering server-side (single delivery truth).
    listDeliveryStatusesMock.mockResolvedValue([{ localId: 'canonical-pending-local', status: 'delivering' }]);
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'canonical-pending-local',
      didWrite: true,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-canonical-pending',
        seq: 44,
        localId: 'canonical-pending-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'canonical pending prompt' },
            localId: 'canonical-pending-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(delivered).toHaveLength(1);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('does not invoke provider input from delayed transcript catch-up after a Queue V2 handoff and runner restart', async () => {
    const localId = 'queue-owned-restart-local';
    const providerInvocations: string[] = [];
    const firstClient = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(firstClient);
    firstClient.onUserMessage((message) => {
      providerInvocations.push(message.content.text);
    });
    materializeNextMock.mockResolvedValue(createProviderDeliveryMaterializeResult(localId));

    await expect(firstClient.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: null,
    });
    expect(providerInvocations).toEqual([`prompt ${localId}`]);
    await firstClient.close();

    const delayedTranscriptUpdate = {
      id: `catchup-message-${localId}`,
      createdAt: 2_000,
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: `message-${localId}`,
          seq: 44,
          localId,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: `prompt ${localId}` },
              localId,
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 2_000,
          updatedAt: 2_000,
        },
      },
    };
    const replacementClient = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 0,
      pendingVersion: 3,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    replacementClient.onUserMessage((message) => {
      providerInvocations.push(message.content.text);
    });
    (replacementClient as unknown as {
      handleUpdate(
        update: unknown,
        opts: {
          source: 'session-scoped';
          catchUpAfterSeq: number;
          catchUpAuthorization: 'explicit_cursor';
        },
      ): void;
    }).handleUpdate(delayedTranscriptUpdate, {
      source: 'session-scoped',
      catchUpAfterSeq: 0,
      catchUpAuthorization: 'explicit_cursor',
    });

    expect(providerInvocations).toEqual([`prompt ${localId}`]);
  });

  it('does not loop materializing the same queued provider-delivery localId while it remains unresolved', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    // The provider-delivery row is still delivering server-side (single delivery truth).
    listDeliveryStatusesMock.mockResolvedValue([{ localId: 'repeat-provider-local', status: 'delivering' }]);
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'repeat-provider-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-repeat-provider',
        seq: 45,
        localId: 'repeat-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'repeat provider prompt' },
            localId: 'repeat-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'repeat-provider-local',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('tracks provider-claimed materialized localIds for provider-acceptance cleanup', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'provider-claim-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-provider-claim',
        seq: null,
        localId: 'provider-claim-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'provider-claim-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-local',
      seq: null,
      deliveryState,
    });

    expect(delivered).toHaveLength(1);
    expect(
      (client as unknown as { hasPendingQueueMaterializedLocalId(localId: string): boolean })
        .hasPendingQueueMaterializedLocalId('provider-claim-local'),
    ).toBe(true);
  });

  it('still materializes on the exact connected session socket while its supervisor is reconnecting', async () => {
    supervisorPhase = 'connecting';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      materializeNextMock.mockResolvedValue({ didMaterialize: false });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result.type).not.toBe('deferred');
      expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({ socket: sessionSocketStub }));
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('returns typed auth failure while the supervisor is auth_failed', async () => {
    supervisorPhase = 'auth_failed';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result).toEqual({ type: 'auth_failure', statusCode: 401 });
      expect(materializeNextMock).not.toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

});
