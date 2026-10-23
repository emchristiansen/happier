import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveProviderPromptFailureDeliveryReason } from '@/agent/runtime/providerPromptSubmission';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import type { SessionMutationOutbox } from '@/api/session/mutations/createSessionMutationOutbox';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

import { createCodexAppServerProviderInputOutcomeBridge } from './codexAppServerProviderInputOutcome';
import { createCodexAppServerRuntime } from './runtime';
import { createCodexAppServerTestEnvScope, writeFakeCodexAppServerScript } from './testkit/fakeCodexAppServer';

// Real Queue custody (ApiSessionClient), the real Codex bridge and the real app-server runtime.
// The fakes are the network edges (server HTTP, sockets, mutation outbox) and the Codex
// app-server process, which is a scripted JSON-RPC peer over stdio.

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

vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub;
  },
}));

vi.mock('@/api/session/connection/createSessionSocketTransport', () => ({
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

vi.mock('@/api/session/mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: (): SessionMutationOutbox => ({
    enqueueSessionTurn: async () => {},
    enqueueTranscriptMessage: async () => ({ persisted: true, delivered: true }),
    enqueueRuntimeActivitySnapshot: async () => ({ persisted: true, delivered: true }),
    setSessionSyncPendingInputServerContract: async () => {},
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
    flush: async () => {},
    close: async () => {},
  }),
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

vi.mock('@/api/session/sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: async () => {},
}));

const materializeNextMock = vi.fn();
const resolveAcceptedPendingDeliveryMock = vi.fn();
const blockPendingDeliveryMock = vi.fn();

vi.mock('@/api/session/pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
    resolveAcceptedPendingQueueV2Delivery: (...args: unknown[]) => resolveAcceptedPendingDeliveryMock(...args),
    blockPendingQueueV2Delivery: (...args: unknown[]) => blockPendingDeliveryMock(...args),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: async () => [],
    listPendingQueueV2DeliveryStatusesFromServer: async () => [],
  };
});

vi.mock('@/api/session/snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/session/snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: async () => ({}),
  };
});

type SessionClientModule = typeof import('@/api/session/sessionClient');
type ApiSessionClient = InstanceType<SessionClientModule['ApiSessionClient']>;

let sessionClientModulePromise: Promise<SessionClientModule> | null = null;
const clients: ApiSessionClient[] = [];
const runtimes: Array<ReturnType<typeof createCodexAppServerRuntime>> = [];
const tempRoots: string[] = [];
let envScope = createCodexAppServerTestEnvScope();

async function createCodexSessionClient(): Promise<ApiSessionClient> {
  sessionSocketStub = createApiSessionSocketStub({
    id: 'session-socket',
    connected: true,
    emitWithAck: (event) => (event === 'ping' ? { v: 1 } : { ok: true }),
  });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('@/api/session/sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const fixture = createPlainSessionFixture({ id: 's1' });
  const client = new ApiSessionClient('tok', {
    ...fixture,
    latestTurnStatus: 'completed',
    pendingCount: 1,
    pendingVersion: 1,
    metadata: { ...fixture.metadata, machineId: 'machine-1', flavor: 'codex' },
  } as ConstructorParameters<SessionClientModule['ApiSessionClient']>[1]);
  clients.push(client);
  (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
  await supervisorConnectedPromise;
  await waitUntil(() => (
    (client as unknown as { sessionSyncPendingInputServerContract?: { mode?: string } })
      .sessionSyncPendingInputServerContract?.mode === 'session_sync_v2_pending_input_v1'
  ));
  return client;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function providerDeliveryMaterializeResult(localId: string, text: string) {
  return {
    didMaterialize: true,
    localId,
    didWrite: false,
    pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
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
          content: { type: 'text', text },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
}

function emptyQueueMaterializeResult() {
  return {
    didMaterialize: false,
    localId: null,
    didWrite: false,
    pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 1, pendingVersion: 3 },
    message: null,
  };
}

/**
 * Scripted Codex app-server. `turn/start` opens a turn that ends only when the test writes the
 * release file. `turn/steer` answers by the steer text: `steer-with-echo` succeeds and echoes the
 * correlated user message, `steer-without-echo` succeeds without the echo, and `steer-refused`
 * is answered with a JSON-RPC error.
 */
async function startScriptedCodexAppServer(): Promise<Readonly<{ root: string; endActiveTurn: () => Promise<void> }>> {
  const root = await createTempDir('happier-codex-outcome-custody-');
  tempRoots.push(root);
  const turnEndReleasePath = join(root, 'end-active-turn');
  const fakeAppServer = await writeFakeCodexAppServerScript({
    dir: root,
    importLines: ['import { readFile } from "node:fs/promises";'],
    setupLines: [
      `const turnEndReleasePath = ${JSON.stringify(turnEndReleasePath)};`,
      'const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    ],
    bodyLines: [
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") { send({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }); continue; }',
      '  if (msg.method === "initialized") continue;',
      '  if (msg.method === "thread/start") { send({ id: msg.id, result: { threadId: "thread-1", model: "gpt-5.4", serviceTier: null } }); continue; }',
      '  if (msg.method === "turn/start") {',
      '    const threadId = msg.params?.threadId ?? "thread-1";',
      '    send({ id: msg.id, result: { turn: { id: "turn-1" }, threadId } });',
      '    send({ method: "turn/started", params: { threadId, turn: { id: "turn-1" } } });',
      '    void (async () => {',
      '      while (!(await readFile(turnEndReleasePath, "utf8").catch(() => ""))) await new Promise((resolve) => setTimeout(resolve, 5));',
      '      send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });',
      '    })();',
      '    continue;',
      '  }',
      '  if (msg.method === "turn/steer") {',
      '    const text = String(msg.params?.input?.[0]?.text ?? "");',
      '    if (text === "steer-refused") { send({ id: msg.id, error: { code: -32000, message: "steer refused by Codex" } }); continue; }',
      '    send({ id: msg.id, result: { turnId: msg.params?.expectedTurnId ?? "turn-1" } });',
      '    if (text === "steer-with-echo") {',
      '      send({ method: "item/started", params: { threadId: msg.params?.threadId ?? "thread-1", turnId: "turn-1", item: { id: "user-echo", type: "userMessage", clientId: msg.params?.clientUserMessageId, content: msg.params?.input ?? [] } } });',
      '    }',
      '    continue;',
      '  }',
      '  if (msg.method === "turn/interrupt") { send({ id: msg.id, result: {} }); continue; }',
      '  send({ id: msg.id, error: { code: -32601, message: "method not found" } });',
      '}',
    ],
  });
  envScope.patch({
    HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
    CODEX_HOME: join(root, 'codex-home'),
    OPENAI_API_KEY: 'test-openai-key',
    CODEX_API_KEY: undefined,
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
    [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
    [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
  });
  return {
    root,
    endActiveTurn: async () => {
      await writeFile(turnEndReleasePath, 'end');
    },
  };
}

/** The runtime and bridge composed the way runCodex composes them for the app-server backend. */
async function startCodexRuntimeOnSession(client: ApiSessionClient, root: string) {
  const bridge = createCodexAppServerProviderInputOutcomeBridge(client, { isCurrentRuntimeMode: () => true });
  const runtime = createCodexAppServerRuntime({
    directory: root,
    onThinkingChange: () => {},
    session: client,
  });
  runtimes.push(runtime);
  runtime.setOnPromptAcceptedByProvider(({ localIds, providerTurnId }) => {
    bridge.observeAccepted({ localIds, providerTurnId });
  });
  runtime.setOnPromptsEffectMayHaveOccurred?.((prompts) => {
    for (const prompt of prompts) bridge.observeEffectMayHaveOccurred({ localIds: prompt.localIds });
  });
  await runtime.startOrLoad({});
  const activeTurn = runtime.sendPrompt('opening prompt');
  await waitUntil(() => runtime.canSteerPrompt());
  return { runtime, activeTurn };
}

function blockReasonsFor(localId: string): unknown[] {
  return blockPendingDeliveryMock.mock.calls
    .map(([request]) => request as { localId?: string; reason?: unknown })
    .filter((request) => request.localId === localId)
    .map((request) => request.reason);
}

describe('Codex app-server provider-input outcomes reach Queue custody', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('@/api/session/sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
      vi.stubEnv(key, offlineBoundary.origin);
    }
    vi.stubGlobal('fetch', offlineBoundary.fetch);
    materializeNextMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockResolvedValue({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    blockPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockResolvedValue({});
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
    vi.useRealTimers();
    for (const runtime of runtimes.splice(0)) {
      await runtime.reset();
    }
    for (const client of clients.splice(0)) {
      await client.close();
    }
    for (const root of tempRoots.splice(0)) {
      await removeTempDir(root);
    }
    envScope.restore();
    envScope = createCodexAppServerTestEnvScope();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('blocks a steer Codex never echoed as uncertain when its turn ends, releasing the Queue', async () => {
    const localId = 'steer-without-echo-local';
    const client = await createCodexSessionClient();
    const { root, endActiveTurn } = await startScriptedCodexAppServer();
    const { runtime, activeTurn } = await startCodexRuntimeOnSession(client, root);
    const steered = vi.fn();
    client.onUserMessage(async (message) => {
      await runtime.steerPrompt(message.content.text, { localId: message.localId });
      steered();
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-without-echo'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    await waitUntil(() => steered.mock.calls.length === 1);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);

    await endActiveTurn();
    await activeTurn;

    await waitUntil(() => blockReasonsFor(localId).length > 0);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    materializeNextMock.mockResolvedValueOnce(emptyQueueMaterializeResult());
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('settles an echoed steer as accepted and never reports it uncertain at turn end', async () => {
    const localId = 'steer-with-echo-local';
    const client = await createCodexSessionClient();
    const { root, endActiveTurn } = await startScriptedCodexAppServer();
    const { runtime, activeTurn } = await startCodexRuntimeOnSession(client, root);
    client.onUserMessage(async (message) => {
      await runtime.steerPrompt(message.content.text, { localId: message.localId });
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-with-echo'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await endActiveTurn();
    await activeTurn;
    await waitUntil(() => !client.hasCanonicalPendingProviderInputDelivery(localId));

    expect(blockReasonsFor(localId)).toEqual([]);
  });

  it('blocks a steer Codex refused as undeliverable, not as an uncertain delivery', async () => {
    const localId = 'steer-refused-local';
    const client = await createCodexSessionClient();
    const { root, endActiveTurn } = await startScriptedCodexAppServer();
    const { runtime, activeTurn } = await startCodexRuntimeOnSession(client, root);
    client.onUserMessage(async (message) => {
      // The steer path's own failure handling in runCodex (`blockProviderPromptDeliveryBeforeAcceptance`).
      try {
        await runtime.steerPrompt(message.content.text, { localId: message.localId });
      } catch (error) {
        await client.blockPendingMessageDelivery({
          localIds: [localId],
          reason: resolveProviderPromptFailureDeliveryReason(error, true),
        });
      }
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-refused'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    await waitUntil(() => blockReasonsFor(localId).length > 0);
    await endActiveTurn();
    await activeTurn;

    expect(blockReasonsFor(localId)).toEqual(['provider_rejected_before_acceptance']);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(false);
  });
});

describe('Queue custody idle backstop', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('@/api/session/sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
      vi.stubEnv(key, offlineBoundary.origin);
    }
    vi.stubGlobal('fetch', offlineBoundary.fetch);
    materializeNextMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockResolvedValue({});
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
    vi.useRealTimers();
    for (const client of clients.splice(0)) {
      await client.close();
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('turns a held input with no provider outcome into an uncertain block after the idle grace, never during a turn', async () => {
    const { PROVIDER_INPUT_OUTCOME_IDLE_GRACE_MS } = await import('@/api/session/sessionClient');
    const localId = 'held-without-outcome-local';
    const client = await createCodexSessionClient();
    // The provider takes the input and never reports any outcome for it.
    const handedToProvider = vi.fn();
    client.onUserMessage(() => {
      handedToProvider();
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'never answered'));
    vi.useFakeTimers();

    // A turn is running: holding the input is legitimate however long the turn lasts.
    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    expect(handedToProvider).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * PROVIDER_INPUT_OUTCOME_IDLE_GRACE_MS);
    expect(blockReasonsFor(localId)).toEqual([]);

    // Idle: the hold is now waiting on nothing, so it lasts only the grace.
    await client.sessionTurnLifecycle.completeTurn({ provider: 'codex' });
    await vi.advanceTimersByTimeAsync(PROVIDER_INPUT_OUTCOME_IDLE_GRACE_MS - 1);
    expect(blockReasonsFor(localId)).toEqual([]);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
    materializeNextMock.mockResolvedValueOnce(emptyQueueMaterializeResult());
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });
});
