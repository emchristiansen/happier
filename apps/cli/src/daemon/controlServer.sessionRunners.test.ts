import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartAllSessionRunnersResultV1, SessionRunnerRuntimeStateV1 } from '@happier-dev/protocol';

import { createDaemonControlApp, startDaemonControlServer } from './controlServer';

// Substitute only socket publication; the actual Fastify app, auth and routes run via inject.
const socketBoundary = vi.hoisted(() => ({ localOnly: false, app: null as import('fastify').FastifyInstance | null }));
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  return { ...actual, default: (options: import('fastify').FastifyServerOptions) => {
    const app = actual.default(options);
    if (socketBoundary.localOnly) {
      socketBoundary.app = app;
      vi.spyOn(app, 'listen').mockImplementation(((_options: unknown, callback: (error: Error | null, address: string) => void) => {
        void app.ready().then(() => callback(null, 'http://127.0.0.1:43210'));
        return app;
      }) as unknown as typeof app.listen);
    }
    return app;
  } };
});

function createBaseControlApp(overrides: Partial<Parameters<typeof createDaemonControlApp>[0]> = {}) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine_local',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'test-token',
    ...overrides,
  });
}

describe('daemon control server: session runner planned restart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves a typed incomplete physical stop outcome at the local control boundary', async () => {
    const stopSession = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const app = createBaseControlApp({ stopSession });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/stop-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ sessionId: 'sess_1' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'incomplete', reason: 'runner_exit_timeout' });
      expect(stopSession).toHaveBeenCalledWith('sess_1');
    } finally {
      await app.close();
    }
  });

  it('requires the daemon control token for bulk planned restarts', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async (): Promise<RestartAllSessionRunnersResultV1> => ({
      ok: true,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'daemon_restart_session_runners',
        }),
      });

      expect(response.statusCode).toBe(401);
      expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed bulk planned restart requests before calling the handler', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async (): Promise<RestartAllSessionRunnersResultV1> => ({
      ok: true,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'not_a_protocol_reason',
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns protocol bulk results with restarted, skipped, and failed session mappings intact', async () => {
    const result: RestartAllSessionRunnersResultV1 = {
      ok: false,
      mode: 'force_current_cli',
      requestedCount: 3,
      restartedCount: 1,
      skippedCount: 1,
      failedCount: 1,
      results: [
        { ok: true, status: 'restarted', sessionId: 'sess_1' },
        {
          ok: false,
          status: 'version_unknown',
          sessionId: 'sess_2',
          reasonCode: 'current_entrypoint_unknown',
        },
        {
          ok: false,
          status: 'spawn_failed',
          sessionId: 'sess_3',
          diagnostics: { error: 'spawn failed' },
        },
      ],
    };
    const handleSessionRunnerRestartAll = vi.fn(async () => result);
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: true,
          reason: 'daemon_restart_session_runners',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(handleSessionRunnerRestartAll).toHaveBeenCalledWith({
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_restart_session_runners',
      });
      expect(response.json()).toEqual(result);
    } finally {
      await app.close();
    }
  });

  it('forwards authenticated session runner status requests to the handler', async () => {
    const result: SessionRunnerRuntimeStateV1 = {
      v: 1,
      sessionId: 'sess_1',
      machineId: 'machine_local',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 1234,
        runtimeId: 'version:1.0.0',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'version:1.1.0',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    };
    const handleSessionRunnerStatusGet = vi.fn(async () => result);
    const app = createBaseControlApp({ handleSessionRunnerStatusGet } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/status',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ sessionId: ' sess_1 ' }),
      });

      expect(response.statusCode).toBe(200);
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess_1' });
      expect(response.json()).toEqual(result);
    } finally {
      await app.close();
    }
  });

  it('wires session runner status requests through the production control server wrapper', async () => {
    const result: SessionRunnerRuntimeStateV1 = {
      v: 1,
      sessionId: 'sess_1',
      machineId: 'machine_local',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 1234,
        runtimeId: 'version:1.0.0',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'version:1.1.0',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    };
    const handleSessionRunnerStatusGet = vi.fn(async () => result);
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerStatusGet,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/session-runners/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        body: JSON.stringify({ sessionId: ' sess_1 ' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(result);
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    } finally {
      await server.stop();
    }
  });
});


describe('signal-free pending queue wake: control server', () => {
  beforeEach(() => {
    socketBoundary.localOnly = true;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected external HTTP'));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('unexpected process signal'); });
  });
  afterEach(() => { socketBoundary.localOnly = false; socketBoundary.app = null; vi.restoreAllMocks(); });

  it.each([
    ['missing token', undefined, { sessionId: 'session_full_1' }, 401],
    ['wrong token', 'wrong', { sessionId: 'session_full_1' }, 401],
    ['empty id', 'test-token', { sessionId: '' }, 400],
    ['extra field', 'test-token', { sessionId: 'session_full_1', resume: true }, 400],
  ] as const)('refuses %s before invoking the owner', async (_label, token, payload, expected) => {
    const handler = vi.fn(async () => ({ type: 'wake_published' as const }));
    const app = createBaseControlApp({ handleSessionPendingQueueWake: handler } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      const response = await app.inject({ method: 'POST', url: '/session-pending-queue-wake', headers: token ? { 'x-happier-daemon-token': token } : {}, payload });
      expect(response.statusCode).toBe(expected);
      expect(handler).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([{ type: 'wake_published' }, { type: 'unavailable', reason: 'publisher_lost' }, { type: 'unavailable', reason: 'rpc_failed' }] as const)('preserves the owner diagnostic $type $reason', async (diagnostic) => {
    const handler = vi.fn(async () => diagnostic);
    const stopSession = vi.fn(); const spawnSession = vi.fn(); const requestShutdown = vi.fn();
    const app = createBaseControlApp({ handleSessionPendingQueueWake: handler, stopSession, spawnSession, requestShutdown } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      const response = await app.inject({ method: 'POST', url: '/session-pending-queue-wake', headers: { 'x-happier-daemon-token': 'test-token' }, payload: { sessionId: 'session_full_1' } });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual(diagnostic);
      expect(handler).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session_full_1' });
      expect(stopSession).not.toHaveBeenCalled(); expect(spawnSession).not.toHaveBeenCalled(); expect(requestShutdown).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(['missing', 'shutdown', 'rejected'] as const)('refuses %s without a lifecycle fallback', async (kind) => {
    const handler = vi.fn(async () => { throw new Error('archive refusal'); });
    const app = createBaseControlApp({ ...(kind === 'missing' ? {} : { handleSessionPendingQueueWake: handler }), isShuttingDown: () => kind === 'shutdown' } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      const response = await app.inject({ method: 'POST', url: '/session-pending-queue-wake', headers: { 'x-happier-daemon-token': 'test-token' }, payload: { sessionId: 'session_full_1' } });
      if (kind === 'missing') { expect(response.statusCode).toBe(501); expect(response.json()).toMatchObject({ errorCode: 'session_pending_queue_wake_handler_unavailable' }); }
      else if (kind === 'shutdown') { expect(response.json()).toEqual({ type: 'unavailable', reason: 'shutdown' }); expect(handler).not.toHaveBeenCalled(); }
      else { expect(response.statusCode).toBe(500); expect(response.json().message).toBe('archive refusal'); }
    } finally { await app.close(); }
  });

  it('forwards the production server callback without opening a socket', async () => {
    const handler = vi.fn(async () => ({ type: 'wake_published' as const }));
    const server = await startDaemonControlServer({ getChildren: () => [], machineId: 'machine_local', stopSession: async () => ({ status: 'not_found' as const }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token', handleSessionPendingQueueWake: handler } as Parameters<typeof startDaemonControlServer>[0]);
    try {
      expect(vi.isMockFunction(socketBoundary.app?.listen)).toBe(true);
      const response = await socketBoundary.app!.inject({ method: 'POST', url: '/session-pending-queue-wake', headers: { 'x-happier-daemon-token': 'test-token' }, payload: { sessionId: 'session_full_1' } });
      expect(response.json()).toEqual({ type: 'wake_published' }); expect(handler).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session_full_1' });
    } finally { await server.stop(); }
  });
});
