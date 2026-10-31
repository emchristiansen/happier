import { mkdir, rename, writeFile } from 'node:fs/promises';
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

// This fixed Node peer spawns no descendants. Mock only the host census; real child
// termination and the app-server client's awaited close remain part of cleanup.
vi.mock('ps-list', () => ({ default: vi.fn().mockResolvedValue([]) }));

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
    enqueueAgentStateRequestSettlement: async () => ({ persisted: true, delivered: true }),
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

type ScriptedUserMessageEcho = Readonly<{
  localId: string;
  /** Omitted fields are left out of the notification, as an incomplete provider echo would. */
  threadId?: string;
  turnId?: string;
}>;

/**
 * Scripted Codex app-server. Each `turn/start` opens `turn-<n>` (counted per process) on
 * `thread-1` and leaves it running; the test ends turns and delivers later notifications by
 * injecting them. `turn/steer` answers by the steer text: `steer-with-echo` succeeds and echoes
 * the correlated user message, `steer-refused` is answered with a JSON-RPC error, and any other
 * text succeeds without an echo.
 */
async function startScriptedCodexAppServer(): Promise<Readonly<{
  root: string;
  endTurn: (turnId: string) => Promise<void>;
  endActiveTurn: () => Promise<void>;
  echoUserMessage: (echo: ScriptedUserMessageEcho) => Promise<void>;
}>> {
  const root = await createTempDir('happier-codex-outcome-custody-');
  tempRoots.push(root);
  const injectDir = join(root, 'inject');
  await mkdir(injectDir);
  let injected = 0;
  const inject = async (message: unknown) => {
    injected += 1;
    const name = String(injected).padStart(6, '0');
    await writeFile(join(injectDir, `${name}.tmp`), JSON.stringify(message));
    await rename(join(injectDir, `${name}.tmp`), join(injectDir, `${name}.json`));
  };
  const fakeAppServer = await writeFakeCodexAppServerScript({
    dir: root,
    importLines: ['import { readdir, readFile, unlink } from "node:fs/promises";'],
    setupLines: [
      `const injectDir = ${JSON.stringify(injectDir)};`,
      'const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
      'let turnCount = 0;',
      'let draining = false;',
      'setInterval(async () => {',
      '  if (draining) return;',
      '  draining = true;',
      '  try {',
      '    const names = (await readdir(injectDir)).filter((name) => name.endsWith(".json")).sort();',
      '    for (const name of names) {',
      '      const path = injectDir + "/" + name;',
      '      const text = await readFile(path, "utf8");',
      '      await unlink(path);',
      '      process.stdout.write(text + "\\n");',
      '    }',
      '  } finally { draining = false; }',
      '}, 5);',
    ],
    bodyLines: [
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") { send({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }); continue; }',
      '  if (msg.method === "initialized") continue;',
      '  if (msg.method === "thread/start") { send({ id: msg.id, result: { threadId: "thread-1", model: "gpt-5.4", serviceTier: null } }); continue; }',
      '  if (msg.method === "turn/start") {',
      '    turnCount += 1;',
      '    const turnId = "turn-" + turnCount;',
      '    const threadId = msg.params?.threadId ?? "thread-1";',
      '    send({ id: msg.id, result: { turn: { id: turnId }, threadId } });',
      '    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });',
      '    continue;',
      '  }',
      '  if (msg.method === "turn/steer") {',
      '    const text = String(msg.params?.input?.[0]?.text ?? "");',
      '    if (text === "steer-refused") { send({ id: msg.id, error: { code: -32000, message: "steer refused by Codex" } }); continue; }',
      '    const turnId = msg.params?.expectedTurnId ?? "turn-" + turnCount;',
      '    send({ id: msg.id, result: { turnId } });',
      '    if (text === "steer-with-echo") {',
      '      send({ method: "item/started", params: { threadId: msg.params?.threadId ?? "thread-1", turnId, item: { id: "user-echo", type: "userMessage", clientId: msg.params?.clientUserMessageId, content: msg.params?.input ?? [] } } });',
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
  const endTurn = async (turnId: string) => {
    await inject({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  };
  return {
    root,
    endTurn,
    endActiveTurn: async () => {
      await endTurn('turn-1');
    },
    echoUserMessage: async ({ localId, threadId, turnId }) => {
      await inject({
        method: 'item/started',
        params: {
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
          item: { id: `user-echo-${localId}-${injected + 1}`, type: 'userMessage', clientId: localId, content: [] },
        },
      });
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
  const providerAcceptances: Array<Readonly<{ localIds?: readonly string[] | null; providerTurnId: string }>> = [];
  runtime.setOnPromptAcceptedByProvider(({ localIds, providerTurnId }) => {
    providerAcceptances.push({ localIds, providerTurnId });
    bridge.observeAccepted({ localIds, providerTurnId });
  });
  runtime.setOnPromptsEffectMayHaveOccurred?.((prompts) => {
    for (const prompt of prompts) bridge.observeEffectMayHaveOccurred({ localIds: prompt.localIds });
  });
  await runtime.startOrLoad({});
  const activeTurn = runtime.sendPrompt('opening prompt');
  await waitUntil(() => runtime.canSteerPrompt());
  return { runtime, activeTurn, providerAcceptances };
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

  it('blocks a steer Codex refused with an RPC error as uncertain, once, without a turn-end report', async () => {
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

    // No source or protocol contract establishes that Codex's error answer to `turn/steer`
    // means the input had no effect, so the refusal stays uncertain.
    expect(blockReasonsFor(localId)).toEqual(['ambiguous_terminal_delivery']);
    materializeNextMock.mockResolvedValueOnce(emptyQueueMaterializeResult());
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed uncertain block on the same live client until the server acknowledges it', async () => {
    vi.stubEnv('HAPPIER_PENDING_CUSTODY_OUTCOME_TIMEOUT_MS', '1000');
    const localId = 'steer-uncertain-block-retried-local';
    const client = await createCodexSessionClient();
    const { root, endActiveTurn } = await startScriptedCodexAppServer();
    const { runtime, activeTurn } = await startCodexRuntimeOnSession(client, root);
    client.onUserMessage(async (message) => {
      await runtime.steerPrompt(message.content.text, { localId: message.localId });
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-without-echo'));
    let releaseFirstBlockResponse!: () => void;
    const firstBlockResponse = new Promise<void>((resolve) => {
      releaseFirstBlockResponse = resolve;
    });
    let acknowledgeRetry!: () => void;
    const retryAcknowledgment = new Promise<void>((resolve) => {
      acknowledgeRetry = resolve;
    });
    blockPendingDeliveryMock
      .mockImplementationOnce(async () => {
        await firstBlockResponse;
        throw new Error('socket hang up');
      })
      .mockImplementationOnce(async () => {
        await retryAcknowledgment;
        return {};
      });

    try {
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toMatchObject({ type: 'materialized', localId });
      await waitUntil(() => client.hasCanonicalPendingProviderInputDelivery(localId));
      // The first response is still held, so its serialized retry cannot pass this observation.
      await waitUntil(() => blockReasonsFor(localId).length === 1);
      expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
      releaseFirstBlockResponse();
      await expect(blockPendingDeliveryMock.mock.results[0]!.value).rejects.toThrow('socket hang up');
      // Let the canonical owner retry before turn-end observation can join the pending write.
      await waitUntil(() => blockReasonsFor(localId).length === 2, 5_000);
      await endActiveTurn();
      await activeTurn;

      // The failed-write obligation releases the queue while any later retry acknowledgment is held.
      materializeNextMock.mockResolvedValueOnce(emptyQueueMaterializeResult());
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'no_pending' });
      expect(materializeNextMock).toHaveBeenCalledTimes(2);

      expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(2);
      expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain', 'delivery_outcome_uncertain']);
      expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
      acknowledgeRetry();
      await expect(blockPendingDeliveryMock.mock.results[1]!.value).resolves.toEqual({});
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(2);
      expect(blockReasonsFor(localId)).toHaveLength(2);
    } finally {
      // Let the existing afterEach runtime/client cleanup settle every pending mock response.
      releaseFirstBlockResponse();
      acknowledgeRetry();
    }
  });

  it('settles an uncertain steer as accepted when Codex echoes it exactly after its turn ended', async () => {
    const localId = 'steer-late-echo-local';
    const client = await createCodexSessionClient();
    const { root, endActiveTurn, echoUserMessage } = await startScriptedCodexAppServer();
    const { runtime, activeTurn } = await startCodexRuntimeOnSession(client, root);
    const steered = vi.fn();
    client.onUserMessage(async (message) => {
      await runtime.steerPrompt(message.content.text, { localId: message.localId });
      steered();
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-without-echo'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    await waitUntil(() => client.hasCanonicalPendingProviderInputDelivery(localId));
    await waitUntil(() => steered.mock.calls.length === 1);
    await endActiveTurn();
    await activeTurn;
    await waitUntil(() => blockReasonsFor(localId).length > 0);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();

    // The echo names the same thread and the ended turn, which the history boundary has consumed.
    await echoUserMessage({ localId, threadId: 'thread-1', turnId: 'turn-1' });
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId }));
    await waitUntil(() => !client.hasCanonicalPendingProviderInputDelivery(localId));
    expect(client.hasPendingProviderInputAcceptance(localId)).toBe(true);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
  });

  /** Steer L into turn-1 without an echo, end turn-1, and wait until L is blocked as uncertain. */
  async function leaveSteerUncertainAfterItsTurn(localId: string) {
    const client = await createCodexSessionClient();
    const fake = await startScriptedCodexAppServer();
    const composed = await startCodexRuntimeOnSession(client, fake.root);
    const steered = vi.fn();
    client.onUserMessage(async (message) => {
      await composed.runtime.steerPrompt(message.content.text, { localId: message.localId });
      steered();
    });
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'steer-without-echo'));
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    await waitUntil(() => steered.mock.calls.length === 1);
    await fake.endTurn('turn-1');
    await composed.activeTurn;
    await waitUntil(() => blockReasonsFor(localId).length > 0);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
    return { client, fake, ...composed };
  }

  function expectStillUncertain(
    client: ApiSessionClient,
    localId: string,
    providerAcceptances: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null }>>,
  ): void {
    expect(providerAcceptances.filter((acceptance) => acceptance.localIds?.includes(localId))).toEqual([]);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect(client.hasPendingProviderInputAcceptance(localId)).toBe(false);
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
  }

  it('does not accept an uncertain steer from an echo that names the successor turn', async () => {
    const localId = 'uncertain-successor-turn-echo-local';
    const { client, fake, runtime, providerAcceptances } = await leaveSteerUncertainAfterItsTurn(localId);
    const successorTurn = runtime.sendPrompt('successor prompt');
    await waitUntil(() => runtime.canSteerPrompt());

    await fake.echoUserMessage({ localId, threadId: 'thread-1', turnId: 'turn-2' });
    await fake.endTurn('turn-2');
    await successorTurn;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expectStillUncertain(client, localId, providerAcceptances);
  });

  it('does not accept an uncertain steer from an echo without thread or turn while a successor turn runs', async () => {
    const localId = 'uncertain-identityless-echo-local';
    const { client, fake, runtime, providerAcceptances } = await leaveSteerUncertainAfterItsTurn(localId);
    const successorTurn = runtime.sendPrompt('successor prompt');
    await waitUntil(() => runtime.canSteerPrompt());

    await fake.echoUserMessage({ localId });
    await fake.endTurn('turn-2');
    await successorTurn;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expectStillUncertain(client, localId, providerAcceptances);
  });

  it('does not accept an uncertain steer from an exact echo delivered on a later client generation', async () => {
    const localId = 'uncertain-later-generation-echo-local';
    const { client, fake, runtime, providerAcceptances } = await leaveSteerUncertainAfterItsTurn(localId);
    // A new app-server client: its first turn reuses the identities thread-1 and turn-1.
    await runtime.reset();
    await runtime.startOrLoad({});
    const laterTurn = runtime.sendPrompt('later-generation prompt');
    await waitUntil(() => runtime.canSteerPrompt());

    await fake.echoUserMessage({ localId, threadId: 'thread-1', turnId: 'turn-1' });
    await fake.endTurn('turn-1');
    await laterTurn;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expectStillUncertain(client, localId, providerAcceptances);
  });
});

describe('Queue canonical custody watchdog', () => {
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

  it.each([false, true])('blocks missing outcomes at the existing 120s timeout (active=%s)', async (active) => {
    const localId = 'held-without-outcome-local';
    const client = await createCodexSessionClient();
    const handedToProvider = vi.fn();
    client.onUserMessage(handedToProvider);
    materializeNextMock.mockResolvedValueOnce(providerDeliveryMaterializeResult(localId, 'never answered'));
    vi.useFakeTimers();
    if (active) await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force', activeTurnSteerability: 'steerable' }))
      .resolves.toMatchObject({ type: 'materialized', localId });
    expect(handedToProvider).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(blockReasonsFor(localId)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(blockReasonsFor(localId)).toEqual(['delivery_outcome_uncertain']);
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    materializeNextMock.mockResolvedValueOnce(emptyQueueMaterializeResult());
    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force', activeTurnSteerability: 'steerable' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    // Blocking releases the queue but retains the original ID for qualified late acceptance.
    expect(client.hasCanonicalPendingProviderInputDelivery(localId)).toBe(true);
  });
});
