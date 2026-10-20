import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionArchiveInputAdmission } from '@/api/session/sessionArchiveInputAdmission';
import type { SessionHookData } from '@/backends/claude/utils/startHookServer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createDeferred } from '@/testkit/async/deferred';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionProviderInputConsumer } from './SessionProviderInputConsumer';
import { DeferredApiSessionClient, type DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { runClaudeUnifiedTerminalSession } from '@/backends/claude/unifiedTerminal/runClaudeUnifiedTerminalSession';
import type { TerminalAttachmentId, TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { logger } from '@/ui/logger';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createCodexAppServerRuntime } from '@/backends/codex/appServer/runtime';
import type { DisposableCodexAppServerClient } from '@/backends/codex/appServer/client/createCodexAppServerClient';

// Exercise the real session logger at its normal level, including when CI enables DEBUG.
vi.hoisted(() => { vi.stubEnv('HAPPIER_LOG_LEVEL', 'info'); });

const origin = 'https://relay.example.invalid';
const sessionId = 'cf1archiveadmission00000000';
const record = () => createSessionRecordFixture({ id: sessionId, machineId: 'f1-offline-machine' });
const features = { features: {}, capabilities: {} };
let sessionSocket: ApiSessionSocketStub;
let userSocket: ApiSessionSocketStub;
let readArchive: (signal: AbortSignal) => Promise<unknown>;
let apiModule: typeof import('@/api/api');
const clients: ApiSessionClient[] = [];
const runtimes: ReturnType<typeof createCodexAppServerRuntime>[] = [];
let providerClient: DisposableCodexAppServerClient;

// The provider process/JSON-RPC transport is the external boundary. Runtime controls,
// RPC registration/invocation and the existing-ID archive admission remain real.
vi.mock('@/backends/codex/appServer/client/createCodexAppServerClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/backends/codex/appServer/client/createCodexAppServerClient')>(),
  createCodexAppServerClient: async () => providerClient,
}));

// HTTP and socket transports are external boundaries. The API factory, session
// client, archive reader, retry owner and consumer execute their real implementations.
vi.mock('axios', async () => {
  const { createOfflineAxios } = await import('@/testkit/http/offlineAxios');
  const offline = createOfflineAxios(async (url) => {
    const path = new URL(url).pathname;
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: record() } };
    if (path === '/health') return { status: 200, data: {} };
    if (path === '/v1/features') return { status: 200, data: features };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'f1-offline-account' } };
    if (path === '/v2/account/settings') return {
      status: 200, data: { version: 1, content: { t: 'plain', v: {} } },
    };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [], hasMore: false } };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
    throw new Error(`Unconfigured offline archive GET: ${url}`);
  });
  return { default: {
    ...offline,
    get: (url: string, options?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
      if (new URL(url).origin === origin && new URL(url).pathname === `/v2/sessions/${sessionId}` && options?.signal && options.headers?.['X-Happier-Request-Purpose'] === 'session-detail:prompt-dispatch-boundary') {
        return readArchive(options.signal);
      }
      return offline.get(url);
    },
  } };
});

vi.mock('socket.io-client', () => ({
  io: (url: string, options: { auth: { clientType: string } }) => {
    if (url !== origin) throw new Error(`Offline socket refused origin: ${url}`);
    if (options.auth.clientType === 'user-scoped') return userSocket;
    if (options.auth.clientType === 'session-scoped') return sessionSocket;
    throw new Error('Unconfigured offline socket client type');
  },
}));

async function createConsumer(attachSessionId = sessionId, requestArchivedSessionCleanup?: () => Promise<{ kind: 'requested' | 'unavailable' }>) {
  sessionSocket = createApiSessionSocketStub({ id: 'f1-session' });
  userSocket = createApiSessionSocketStub({ id: 'f1-user' });
  const api = await apiModule.ApiClient.create({
    token: 'synthetic-f1-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
  });
  const session = api.sessionSyncClient(createPlainSessionFixture({ id: sessionId }), undefined,
    { existingSessionId: attachSessionId, requestArchivedSessionCleanup });
  clients.push(session);
  const queue = new MessageQueue2<{ id: string }>(() => 'original-hash');
  return { session, queue, consumer: createSessionProviderInputConsumer({ messageQueue: queue, session }) };
}

async function attachDirectControls(session: ApiSessionClient, options: {
  loadThread?: boolean;
  waitForThreadStart?: () => Promise<void>;
} = {}) {
  const notifications = new Map<string, (params: unknown) => void | Promise<void>>();
  const request = vi.fn<DisposableCodexAppServerClient['request']>(async (method, params) => {
    if (method === 'thread/resume' || method === 'thread/start') {
      await options.waitForThreadStart?.();
      return { thread: { id: 'f1-direct-thread', turns: [] } };
    }
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'collaborationMode/list' || method === 'model/list') return { data: [] };
    if (method === 'thread/goal/set') return { goal: { ...(params as Record<string, unknown>), id: 'f1-direct-goal' } };
    if (method === 'review/start') {
      setImmediate(() => {
        void notifications.get('turn/completed')?.({
          threadId: 'f1-direct-thread', turn: { id: 'f1-direct-review', status: 'completed' },
        });
      });
      return { turn: { id: 'f1-direct-review' } };
    }
    throw new Error(`Unconfigured offline Codex request: ${method}`);
  });
  providerClient = {
    request, notify: async () => {}, dispose: async () => {},
    onExit: () => () => {}, registerRequestHandler: () => () => {},
    registerNotificationHandler: (method, handler) => {
      notifications.set(method, handler);
      return () => { notifications.delete(method); };
    },
  };
  const runtime = createCodexAppServerRuntime({
    directory: process.cwd(), session, onThinkingChange: () => {},
    // The synthetic external transport never needs provider credentials or runtime auth.
    processEnv: {},
  });
  runtimes.push(runtime);
  if (options.loadThread !== false) await runtime.startOrLoad({ resumeId: 'f1-direct-thread', importHistory: false });
  session.setSessionRuntimeControls(runtime);
  return { runtime, request };
}

function invokeDirectControl(session: ApiSessionClient, kind: 'goal' | 'review') {
  return kind === 'goal'
    ? session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_SET, {
      objective: 'Retain this exact goal', status: 'paused', tokenBudget: 1200,
    })
    : session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, {
      engineIds: ['codex'], instructions: 'Retain this exact review', runLocation: 'current_session',
      changeType: 'uncommitted', base: { kind: 'none' },
    });
}

describe('archived session input admission', () => {
  beforeAll(async () => {
    for (const name of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']) {
      vi.stubEnv(name, origin);
    }
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', '0');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== origin || url.pathname !== '/v1/features') {
        throw new Error(`Unconfigured offline fetch: ${url.href}`);
      }
      return new Response(JSON.stringify(features), { status: 200 });
    }));
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    apiModule = await import('@/api/api');
  }, 120_000);

  afterEach(async () => {
    vi.useRealTimers();
    for (const runtime of runtimes.splice(0)) await runtime.reset();
    for (const client of clients.splice(0)) await client.close();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('binds the canonical existing identity after the resume parser trims whitespace', async () => {
    const { session } = await createConsumer(` ${sessionId} `);
    expect(session.sessionId).toBe(sessionId);
  });

  it('refuses an existing-identity admission binding for a different session', async () => {
    await expect(createConsumer('different-existing-session')).rejects.toThrow('exact attached session identity');
  });

  it('retains the exact queued input while archive admission is unreadable', async () => {
    const read = createDeferred<unknown>();
    readArchive = async () => await read.promise;
    const { queue, consumer } = await createConsumer();
    const abort = new AbortController();
    queue.push('original body', { id: 'original-mode' }, {
      userMessageLocalId: 'original-local-id', providerAcceptancePending: true, pendingProviderAction: 'send',
    });
    const input = consumer.waitForNextInput({ abortSignal: abort.signal });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queue.size()).toBe(1);
      read.resolve({ status: 200, data: { session: record() } });
      await expect(input).resolves.toMatchObject({
        message: 'original body', mode: { id: 'original-mode' },
        userMessageLocalIds: ['original-local-id'], providerAcceptancePending: true,
      });
    } finally {
      abort.abort();
      read.resolve({ status: 503, data: {} });
      await input;
    }
  });

  it('refuses an archived session before invoking the provider', async () => {
    readArchive = async () => ({ status: 200, data: { session: { ...record(), archivedAt: 42 } } });
    const { consumer } = await createConsumer();
    const dispatch = vi.fn(async () => 'provider-accepted');
    await expect(consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal, dispatch,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['goal', 'review'] as const)('refuses the first direct %s RPC after an existing-ID attach is archived', async (kind) => {
    let archivedAt: number | null = null;
    readArchive = async () => ({ status: 200, data: { session: { ...record(), archivedAt } } });
    const cleanup = vi.fn(async () => ({ kind: 'requested' as const }));
    const { session } = await createConsumer(sessionId, cleanup);
    await expect(session.waitForProviderInputAdmission(new AbortController().signal)).resolves.toBe(true);
    const { request } = await attachDirectControls(session);
    archivedAt = 42;
    await expect(invokeDirectControl(session, kind)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set' || method === 'review/start')).toEqual([]);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it.each(['goal', 'review'] as const)('retains the original direct %s RPC while archive state is unreadable', async (kind) => {
    readArchive = async () => ({ status: 200, data: { session: record() } });
    const { session } = await createConsumer();
    await expect(session.waitForProviderInputAdmission(new AbortController().signal)).resolves.toBe(true);
    const { request } = await attachDirectControls(session);
    const retryStarted = createDeferred<void>();
    const readable = createDeferred<unknown>();
    let reads = 0;
    readArchive = async () => {
      if (++reads === 1) return { status: 503, data: {} };
      retryStarted.resolve();
      return await readable.promise;
    };
    const result = invokeDirectControl(session, kind);
    try {
      await Promise.race([retryStarted.promise, result.then(() => { throw new Error('Direct RPC completed before archive admission'); })]);
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set' || method === 'review/start')).toEqual([]);
      readable.resolve({ status: 200, data: { session: record() } });
      await result;
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set' || method === 'review/start')).toEqual([
        kind === 'goal' ? ['thread/goal/set', {
          threadId: 'f1-direct-thread', objective: 'Retain this exact goal', status: 'paused', tokenBudget: 1200,
        }] : ['review/start', {
          threadId: 'f1-direct-thread', target: {
            type: 'custom', instructions: expect.stringContaining('Retain this exact review'),
          }, delivery: 'inline',
        }],
      ]);
    } finally {
      readable.resolve({ status: 503, data: {} });
      session.beginRuntimeTermination();
      await result.catch(() => {});
    }
  });

  it.each([
    ['goal', 'cancel'], ['review', 'cancel'], ['goal', 'reset'], ['review', 'reset'],
    ['goal', 'close'], ['review', 'close'],
  ] as const)('cancels a pending direct %s RPC when its own runtime/session receives %s', async (kind, cancellation) => {
    readArchive = async () => ({ status: 200, data: { session: record() } });
    const { session } = await createConsumer();
    const { runtime, request } = await attachDirectControls(session);
    const started = createDeferred<void>();
    readArchive = async (signal) => {
      started.resolve();
      return await new Promise((resolve) => {
        const abort = () => resolve({ status: 503, data: {} });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    };
    const result = invokeDirectControl(session, kind);
    let settled = false;
    const outcome = result.then(
      (value) => { settled = true; return { kind: 'success' as const, value }; },
      (error: unknown) => { settled = true; return { kind: 'failure' as const, error }; },
    );
    let close: Promise<void> | undefined;
    try {
      await Promise.race([started.promise, outcome.then(() => { throw new Error('Direct RPC completed before archive admission'); })]);
      if (cancellation === 'close') close = session.close();
      else await runtime[cancellation]();
      await vi.waitFor(() => expect(settled).toBe(true));
      await expect(outcome).resolves.toMatchObject({ kind: 'failure', error: { name: 'AbortError' } });
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set' || method === 'review/start')).toEqual([]);
    } finally {
      session.beginRuntimeTermination();
      await outcome;
      if (close) {
        await close;
        clients.splice(clients.indexOf(session), 1);
      }
    }
  });

  it.each(['cancel', 'reset'] as const)('keeps a direct review cancelled during initial thread setup after %s', async (cancellation) => {
    readArchive = async () => ({ status: 200, data: { session: record() } });
    const { session } = await createConsumer();
    const started = createDeferred<void>();
    const attached = createDeferred<void>();
    const { runtime, request } = await attachDirectControls(session, {
      loadThread: false,
      waitForThreadStart: async () => { started.resolve(); await attached.promise; },
    });
    const result = invokeDirectControl(session, 'review');
    const outcome = result.then(
      (value) => ({ kind: 'success' as const, value }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    );
    try {
      await started.promise;
      await runtime[cancellation]();
      attached.resolve();
      await expect(outcome).resolves.toMatchObject({ kind: 'failure', error: { name: 'AbortError' } });
      expect(request.mock.calls.filter(([method]) => method === 'review/start')).toEqual([]);
    } finally {
      attached.resolve();
      session.beginRuntimeTermination();
      await outcome;
    }
  });

  it.each([
    ['setup', 'cancel'], ['setup', 'reset'], ['admission', 'cancel'], ['admission', 'reset'],
  ] as const)('keeps an initial goal cancelled during delayed %s after %s', async (boundary, cancellation) => {
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    readArchive = async () => {
      if (boundary === 'admission') { started.resolve(); await released.promise; }
      return { status: 200, data: { session: record() } };
    };
    const { session } = await createConsumer();
    const { runtime, request } = await attachDirectControls(session, {
      loadThread: false,
      waitForThreadStart: boundary === 'setup'
        ? async () => { started.resolve(); await released.promise; }
        : undefined,
    });
    const result = runtime.startOrLoad({
      resumeId: 'f1-direct-thread', importHistory: false,
      initialGoal: { objective: 'Do not run this abandoned initial goal' },
    });
    const outcome = result.then(
      () => ({ kind: 'success' as const }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    );
    try {
      await started.promise;
      await runtime[cancellation]();
      // A transport may complete after cancellation. A positive late reply is not permission.
      released.resolve();
      await expect(outcome).resolves.toMatchObject({ kind: 'failure', error: { name: 'AbortError' } });
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toEqual([]);
    } finally {
      released.resolve();
      session.beginRuntimeTermination();
      await outcome;
    }
  });

  it.each(['before runtime entry', 'during setup'] as const)(
    'keeps the original caller initial goal cancelled %s without cancelling a future goal', async (boundary) => {
      readArchive = async () => ({ status: 200, data: { session: record() } });
      const started = createDeferred<void>();
      const released = createDeferred<void>();
      const originalRequest = new AbortController();
      const { session } = await createConsumer();
      const { runtime, request } = await attachDirectControls(session, {
        loadThread: false,
        waitForThreadStart: boundary === 'during setup'
          ? async () => { started.resolve(); await released.promise; }
          : undefined,
      });
      if (boundary === 'before runtime entry') {
        originalRequest.abort();
        // The runtime has already installed the next direct-control generation.
        await runtime.cancel();
      }
      const outcome = runtime.startOrLoad({
        resumeId: 'f1-direct-thread', importHistory: false,
        initialGoal: { objective: 'Do not revive the original caller goal' },
        initialGoalSignal: originalRequest.signal,
      }).then(
        () => ({ kind: 'success' as const }),
        (error: unknown) => ({ kind: 'failure' as const, error }),
      );
      try {
        if (boundary === 'during setup') {
          await started.promise;
          originalRequest.abort();
          released.resolve();
        }
        await expect(outcome).resolves.toMatchObject({ kind: 'failure', error: { name: 'AbortError' } });
        expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toEqual([]);
        // Abandoning the bootstrap request must leave later RPC requests usable.
        await invokeDirectControl(session, 'goal');
        expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toEqual([
          ['thread/goal/set', { threadId: 'f1-direct-thread', objective: 'Retain this exact goal', status: 'paused', tokenBudget: 1200 }],
        ]);
      } finally {
        released.resolve();
        session.beginRuntimeTermination();
        await outcome;
      }
    },
  );

  it('retains the exact initial goal through unreadable admission until it becomes available', async () => {
    const retryStarted = createDeferred<void>();
    const readable = createDeferred<unknown>();
    let reads = 0;
    readArchive = async () => {
      if (++reads === 1) return { status: 503, data: {} };
      retryStarted.resolve();
      return await readable.promise;
    };
    const { session } = await createConsumer();
    const { runtime, request } = await attachDirectControls(session, { loadThread: false });
    const result = runtime.startOrLoad({
      resumeId: 'f1-direct-thread', importHistory: false,
      initialGoal: { objective: 'Retain this exact initial goal', status: 'paused', tokenBudget: 1200 },
    });
    try {
      await retryStarted.promise;
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toEqual([]);
      readable.resolve({ status: 200, data: { session: record() } });
      await result;
      expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toEqual([
        ['thread/goal/set', { threadId: 'f1-direct-thread', objective: 'Retain this exact initial goal', status: 'paused', tokenBudget: 1200 }],
      ]);
    } finally {
      readable.resolve({ status: 503, data: {} });
      session.beginRuntimeTermination();
      await result.catch(() => {});
    }
  });

  it.each(['during response', 'after response'] as const)('honors the physical archive HTTP retry floor across fresh connection events %s', async (eventTiming) => {
    const response = createDeferred<unknown>();
    let reads = 0;
    readArchive = async () => ++reads === 1 ? response.promise : { status: 200, data: { session: record() } };
    const events = new EventEmitter();
    const abort = new AbortController();
    let epoch = 1;
    const admission = new SessionArchiveInputAdmission({
      token: 'synthetic-f1-token', sessionId, lifetime: abort.signal, connectionEpoch: () => epoch,
      waitForFreshEvent: (signal) => new Promise<boolean>((resolve) => {
        const finish = (updated: boolean) => { events.off('eligibility', onEvent); signal.removeEventListener('abort', onAbort); resolve(updated); };
        const onEvent = () => finish(true);
        const onAbort = () => finish(false);
        events.on('eligibility', onEvent);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
      requestArchivedStop: async () => { throw new Error('unarchived result must not request a stop'); },
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let finished = false;
    const result = admission.wait(abort.signal).then((value) => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      if (eventTiming === 'during response') { epoch += 1; events.emit('eligibility'); }
      response.resolve({ status: 429, headers: { 'retry-after': '60' }, data: {} });
      await vi.advanceTimersByTimeAsync(0);
      if (eventTiming === 'after response') { epoch += 1; events.emit('eligibility'); }
      await vi.advanceTimersByTimeAsync(59_999);
      events.emit('eligibility');
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(true);
      expect(reads).toBe(2);
    } finally {
      abort.abort();
      response.resolve({ status: 503, data: {} });
      await vi.advanceTimersByTimeAsync(0);
      await result;
    }
  });

  it('cleans only the observing runner after a delayed archive read and successor attachment', async () => {
    const read = createDeferred<unknown>();
    const started = createDeferred<void>();
    readArchive = async () => { started.resolve(); return await read.promise; };
    const cleanupA = vi.fn(async () => ({ kind: 'requested' as const }));
    const cleanupB = vi.fn(async () => ({ kind: 'requested' as const }));
    const { consumer } = await createConsumer(sessionId, cleanupA);
    const dispatch = vi.fn(async () => 'accepted');
    const result = consumer.runProviderInputDispatch({ abortSignal: new AbortController().signal, dispatch });
    await started.promise;
    // A later attachment must never become the target of A's delayed observation.
    await createConsumer(sessionId, cleanupB);
    read.resolve({ status: 200, data: { session: { ...record(), archivedAt: 42 } } });
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    await vi.waitFor(() => expect(cleanupA).toHaveBeenCalledTimes(1));
    expect(cleanupB).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failed'] as const)('keeps input refused when exact local cleanup is %s', async (cleanupState) => {
    const read = createDeferred<unknown>();
    const readStarted = createDeferred<void>();
    readArchive = async () => { readStarted.resolve(); return await read.promise; };
    const cleanup = vi.fn(async () => {
      if (cleanupState === 'failed') throw new Error('injected owned cleanup failure');
      return { kind: 'unavailable' as const };
    });
    const { consumer, queue } = await createConsumer(sessionId, cleanup);
    logger.infoFile('[archiveAdmission test] normal-info baseline');
    logger.flushSync();
    const before = await readFile(logger.getLogPath(), 'utf8');
    const debugMarker = `[archiveAdmission test] debug-only ${cleanupState}`;
    logger.debug(debugMarker);
    queue.push('retained body', { id: 'retained-mode' }, { userMessageLocalId: 'retained-id' });
    const input = consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await readStarted.promise;
    const successorCleanup = vi.fn(async () => ({ kind: 'requested' as const }));
    await createConsumer(sessionId, successorCleanup);
    read.resolve({ status: 200, data: { session: { ...record(), archivedAt: 42 } } });
    await expect(input).resolves.toBeNull();
    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toBeNull();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      logger.flushSync();
      const entries = (await readFile(logger.getLogPath(), 'utf8')).slice(before.length);
      expect(entries).toContain(cleanupState === 'unavailable' ? 'cleanup owner unavailable' : 'cleanup request failed');
      expect(entries).toContain('input refused, physical cleanup unconfirmed');
      expect(entries).not.toContain(debugMarker);
    });
    const dispatch = vi.fn(async () => 'must not accept retained input');
    await expect(consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal, dispatch,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(successorCleanup).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
  });

  it('does not dispatch a reserved input after admission closes during the read', async () => {
    const read = createDeferred<unknown>();
    const readStarted = createDeferred<void>();
    readArchive = async () => { readStarted.resolve(); return await read.promise; };
    const { consumer } = await createConsumer();
    const dispatch = vi.fn(async () => 'provider-accepted');
    const result = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal, dispatch,
    });
    await readStarted.promise;
    await consumer.closeProviderInputAdmissionAndWaitForDispatches();
    read.resolve({ status: 200, data: { session: record() } });
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing archive field', () => { const { archivedAt: _omitted, ...row } = record(); return { status: 200, data: { session: row } }; }],
    ['missing row', () => ({ status: 404, data: {} })],
    ['malformed acknowledgement', () => ({ status: 200, data: { session: {} } })],
    ['unavailable response', () => ({ status: 503, data: {} })],
  ] as const)('retains the original input across %s until a fresh successful read', async (_name, unavailable) => {
    let reads = 0;
    const retryStarted = createDeferred<void>();
    const retryResponse = createDeferred<unknown>();
    readArchive = async () => {
      if (++reads === 1) return unavailable();
      retryStarted.resolve();
      return await retryResponse.promise;
    };
    const { queue, consumer } = await createConsumer();
    const abort = new AbortController();
    queue.push('unchanged retry body', { id: 'unchanged-mode' }, { userMessageLocalId: 'unchanged-id' });
    const result = consumer.waitForNextInput({ abortSignal: abort.signal });
    try {
      await retryStarted.promise;
      expect(queue.size()).toBe(1);
      retryResponse.resolve({ status: 200, data: { session: record() } });
      await expect(result).resolves.toMatchObject({
        message: 'unchanged retry body', mode: { id: 'unchanged-mode' }, userMessageLocalIds: ['unchanged-id'],
      });
      expect(reads).toBe(2);
    } finally { abort.abort(); retryResponse.resolve({ status: 503, data: {} }); await result; }
  });

  it('does not memoize an earlier successful read for a later provider dispatch', async () => {
    let archivedAt: number | null = null;
    readArchive = async () => ({ status: 200, data: { session: { ...record(), archivedAt } } });
    const { consumer } = await createConsumer();
    const dispatch = vi.fn(async () => 'accepted');
    const options = { abortSignal: new AbortController().signal, dispatch };
    await expect(consumer.runProviderInputDispatch(options)).resolves.toEqual({ status: 'dispatched', value: 'accepted' });
    archivedAt = 42;
    await expect(consumer.runProviderInputDispatch(options)).resolves.toEqual({ status: 'cancelled' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a positive response from an old connection generation and rereads', async () => {
    const oldRead = createDeferred<unknown>();
    let reads = 0;
    readArchive = async () => ++reads === 1 ? oldRead.promise : { status: 200, data: { session: { ...record(), archivedAt: 42 } } };
    const { consumer } = await createConsumer();
    const dispatch = vi.fn(async () => 'must-not-run');
    const result = consumer.runProviderInputDispatch({ abortSignal: new AbortController().signal, dispatch });
    await vi.waitFor(() => expect(reads).toBe(1));
    sessionSocket.trigger('connect');
    oldRead.resolve({ status: 200, data: { session: record() } });
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(reads).toBe(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retains an exhausted archive admission episode until a fresh external eligibility event', async () => {
    let reads = 0;
    let available = false;
    readArchive = async () => { reads += 1; return available ? { status: 200, data: { session: record() } } : { status: 503, data: {} }; };
    const events = new EventEmitter();
    const abort = new AbortController();
    const admission = new SessionArchiveInputAdmission({
      token: 'synthetic-f1-token', sessionId, lifetime: abort.signal, connectionEpoch: () => 1,
      waitForFreshEvent: (signal) => new Promise<boolean>((resolve) => {
        const finish = (updated: boolean) => { events.off('eligibility', onEvent); signal.removeEventListener('abort', onAbort); resolve(updated); };
        const onEvent = () => finish(true);
        const onAbort = () => finish(false);
        events.on('eligibility', onEvent);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
      requestArchivedStop: async () => { throw new Error('unarchived result must not request a stop'); },
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let finished = false;
    const result = admission.wait(abort.signal).then((value) => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(reads).toBe(12);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(reads).toBe(12);
      available = true;
      events.emit('eligibility');
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toBe(true);
      expect(reads).toBe(13);
      expect(events.listenerCount('eligibility')).toBe(0);
    } finally { abort.abort(); await vi.advanceTimersByTimeAsync(0); await result; }
  });

  it('parks existing-ID fast-start input until the real attached client can read archive state', async () => {
    let reads = 0;
    readArchive = async () => { reads += 1; return { status: 200, data: { session: { ...record(), archivedAt: 42 } } }; };
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-f1-fast-start', existingSessionId: sessionId,
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const abort = new AbortController();
    let finished = false;
    const admission = deferred.waitForProviderInputAdmission(abort.signal).then((value) => { finished = true; return value; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(reads).toBe(0);
    const { session } = await createConsumer();
    // Match the existing startup adapter: its generic event port predates the concrete event type.
    await deferred.attach(session as unknown as DeferredApiSessionTarget);
    await expect(admission).resolves.toBe(false);
    expect(reads).toBe(1);
  });

  it('cancels an unattached existing-ID fast-start wait without authorizing input', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-f1-cancelled', existingSessionId: sessionId,
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const admission = deferred.waitForProviderInputAdmission(new AbortController().signal);
    deferred.cancel();
    await expect(admission).resolves.toBe(false);
  });


  it.each([['initial goal', 'allowed'], ['queued prompt', 'allowed'], ['queued prompt', 'archived'], ['queued prompt', 'unavailable']] as const)('holds the actual terminal writer for %s with %s archive admission', async (kind, outcome) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'f1-terminal-admission-'));
    const transcriptPath = join(fixtureRoot, 'f1-provider-resume.jsonl');
    await writeFile(transcriptPath, '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', fixtureRoot);
    const response = createDeferred<unknown>();
    const readStarted = createDeferred<void>();
    readArchive = async () => { readStarted.resolve(); return await response.promise; };
    const { session } = await createConsumer();
    const abort = new AbortController();
    const handle: TerminalHostHandle = {
      attachmentId: 'f1-offline-attachment' as TerminalAttachmentId,
      kind: 'tmux', sessionName: 'f1-offline-host', paneId: '%1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
    };
    const written = createDeferred<void>();
    const injectUserPrompt = vi.fn<TerminalHostAdapter['injectUserPrompt']>(async () => {
      written.resolve();
      abort.abort();
      return { status: 'injected' as const, at: Date.now(), bytesWritten: 0 };
    });
    let hook: ((data: SessionHookData) => void) | undefined;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux', createOrAttachHost: async () => {
        hook?.({ hook_event_name: 'SessionStart', session_id: 'f1-provider-resume', transcript_path: transcriptPath, source: 'resume' });
        return handle;
      }, injectUserPrompt,
      captureInputState: async () => ({ stable: true, currentInput: 'What would you like to work on?\n> ', observedAt: Date.now() }),
      interruptTurn: async () => {}, evaluateLiveness: async () => ({ paneAlive: true, observedAt: Date.now() }), dispose: async () => {},
    };
    let pulled = false;
    const returned: unknown[] = [];
    const onPromptAcceptedByProvider = vi.fn();
    const run = runClaudeUnifiedTerminalSession({
      path: process.cwd(), happySessionId: sessionId, sessionId: 'f1-provider-resume',
      transcriptPath, hookPluginDir: join(fixtureRoot, 'hook-plugin'),
      initialMode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
      initialGoalObjective: kind === 'initial goal' ? 'exact original goal' : undefined,
      returnUnconsumedMessage: (batch) => { returned.push(batch); },
      onPromptAcceptedByProvider,
      waitForProviderInputAdmission: (signal) => session.waitForProviderInputAdmission(signal),
      nextMessage: async () => {
        if (kind === 'queued prompt' && !pulled) {
          pulled = true;
          return { message: 'exact original prompt', mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' }, userMessageLocalIds: ['exact-terminal-id'] };
        }
        if (!abort.signal.aborted) await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
        return null;
      },
      signal: abort.signal, processSignals: null,
      subscribeClaudeSessionHooks: (callback) => { hook = callback; return () => { hook = undefined; }; },
      dialogTurnEndScreenProbeDelaysMs: [], lifecycleCompletionQuiescenceMs: 0,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'offline' }),
      readTerminalHostAttachmentInfo: async () => null,
      persistTerminalHostAttachmentInfo: async () => {},
      buildSpawn: async () => ({ spawnArgv: ['/offline/provider', '--resume', 'f1-provider-resume'], spawnEnv: {} }),
      createSessionName: () => 'f1-offline-host',
    });
    try {
      await readStarted.promise;
      expect(injectUserPrompt).not.toHaveBeenCalled();
      response.resolve(outcome === 'unavailable' ? { status: 503, data: {} } : {
        status: 200, data: { session: { ...record(), archivedAt: outcome === 'archived' ? 42 : null } },
      });
      if (outcome === 'allowed') {
        await written.promise;
        await run;
        expect(injectUserPrompt).toHaveBeenCalledTimes(1);
        expect(injectUserPrompt.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
          text: kind === 'initial goal' ? '/goal exact original goal' : 'exact original prompt',
        }));
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
        abort.abort();
        await run;
        expect(injectUserPrompt).not.toHaveBeenCalled();
        expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
        expect(returned).toContainEqual(expect.objectContaining({
          message: 'exact original prompt', userMessageLocalIds: ['exact-terminal-id'],
        }));
      }
    } finally {
      abort.abort();
      response.resolve({ status: 503, data: {} });
      await run;
    }
  });

});
