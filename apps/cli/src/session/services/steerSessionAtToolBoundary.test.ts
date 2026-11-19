import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler } from '@/api/rpc/types';
import { createClaudeToolBoundarySteering } from '@/backends/claude/utils/postToolUseSteeringBroker';
import { startHookServer, type HookServer } from '@/backends/claude/utils/startHookServer';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { createRpcAcknowledgementError, markRpcRequestDisposition } from '@/session/transport/rpc/rpcRequestDisposition';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

/**
 * Composition of the public client, the session RPC relay boundary, the real runner handler,
 * the real Claude steering broker, the real HookServer and the real session forwarder executable.
 * Only the server transports (session lookup and socket relay) are replaced.
 */

type Relay = (method: string, request: unknown) => Promise<unknown>;

const machineKey = new Uint8Array(32).fill(1);
const credentials = { token: 'token', encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey } };

function runForwarder(port: number, body: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs'), String(port), 'PostToolUse'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(body));
  });
}

function additionalContextOf(stdout: string): string | null {
  return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : null;
}

describe('steerSessionAtToolBoundary', () => {
  let hookServer: HookServer | undefined;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    hookServer?.stop();
    hookServer = undefined;
    vi.doUnmock('./resolveSessionTransportContext');
    vi.doUnmock('@/session/transport/rpc/sessionRpc');
  });

  async function load(params: Readonly<{ active: boolean; relay: Relay }>) {
    const callSessionRpc = vi.fn(async (call: Readonly<{ method: string; request: unknown }>) => await params.relay(call.method, call.request));
    vi.doMock('./resolveSessionTransportContext', () => ({
      resolveSessionTransportContext: vi.fn(async () => ({
        ok: true,
        sessionId: 'sess-1',
        mode: 'plain',
        ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' },
        rawSession: { id: 'sess-1', active: params.active, metadata: '{}', agentState: null },
      })),
    }));
    vi.doMock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));
    const { steerSessionAtToolBoundary } = await import('./steerSessionAtToolBoundary');
    return { steerSessionAtToolBoundary, callSessionRpc };
  }

  /** A relay to a live runner: unregistered methods fail as the server relay does. */
  function runnerRelay(controls: SessionRuntimeControls | undefined): Relay {
    const handlers = new Map<string, RpcHandler>();
    registerSessionHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, process.cwd(), {
      ...(controls ? { sessionRuntimeControls: controls } : {}),
    });
    return async (method, request) => {
      const handler = handlers.get(method.slice('sess-1:'.length));
      if (!handler) {
        throw createRpcAcknowledgementError({ error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
      }
      return await handler(request);
    };
  }

  async function startClaudeRunner() {
    const steering = createClaudeToolBoundarySteering({ readExpectedSessionId: () => 'claude-main' });
    hookServer = await startHookServer({ onSessionHook: () => {}, produceSessionHookOutput: steering.produceSessionHookOutput });
    return { port: hookServer.port, relay: runnerRelay({ steerAtToolBoundary: steering.steerAtToolBoundary }) };
  }

  it('refuses an inactive session without resuming it or creating Pending input', async () => {
    const relay = vi.fn<Relay>();
    const { steerSessionAtToolBoundary, callSessionRpc } = await load({ active: false, relay });
    await expect(steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'hi', waitMs: 1_000 }))
      .resolves.toEqual({ ok: false, sessionId: 'sess-1', code: 'session_inactive' });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses inactive CLI steering before any RPC without resuming or queueing', async () => {
    const relay = vi.fn<Relay>();
    const { callSessionRpc } = await load({ active: false, relay });
    const { cmdSessionSteer } = await import('@/cli/commands/session/steer');
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionSteer(['steer', 'sess-1', 'hello', '--from', 'worker/123', '--wait-ms', '100', '--json'], { readCredentialsFn: async () => credentials });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'session_inactive' } });
      expect(callSessionRpc).not.toHaveBeenCalled();
    } finally { output.restore(); process.exitCode = 0; }
  });

  it('refuses when the runner does not serve tool-boundary steering', async () => {
    const oldRunner: Relay = async (method) => {
      // Older runners never register the method; the relay reports it unavailable.
      seenMethods.push(method);
      throw createRpcAcknowledgementError({ error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    };
    const seenMethods: string[] = [];
    const old = await load({ active: true, relay: oldRunner });
    await expect(old.steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'hi', waitMs: 1_000 }))
      .resolves.toEqual({ ok: false, sessionId: 'sess-1', code: 'runner_unavailable' });
    expect(seenMethods).toEqual([`sess-1:${SESSION_RPC_METHODS.SESSION_TOOL_BOUNDARY_STEER_V1}`]);

    vi.resetModules();
    const brokerless = await load({ active: true, relay: runnerRelay({}) });
    await expect(brokerless.steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'hi', waitMs: 1_000 }))
      .resolves.toEqual({ ok: false, sessionId: 'sess-1', code: 'steering_unavailable' });
  });

  it('writes the message into the next primary PostToolUse response of an active Claude runner', async () => {
    const runner = await startClaudeRunner();
    const { steerSessionAtToolBoundary } = await load({ active: true, relay: runner.relay });
    const result = steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'please also run lint', waitMs: 10_000 });
    let hook: Awaited<ReturnType<typeof runForwarder>> | undefined;
    // The hook never waits for steering; keep firing tool boundaries until one carries it.
    for (let attempt = 0; attempt < 50 && !additionalContextOf(hook?.stdout ?? ''); attempt += 1) {
      hook = await runForwarder(runner.port, { session_id: 'claude-main' });
    }
    expect(hook?.code).toBe(0);
    expect(additionalContextOf(hook!.stdout)).toBe('please also run lint');
    await expect(result).resolves.toEqual({ ok: true, sessionId: 'sess-1', result: 'written_to_hook_response' });
  });

  it('carries caller attribution from the CLI command through the real broker and forwarder', async () => {
    const runner = await startClaudeRunner();
    await load({ active: true, relay: runner.relay });
    const { cmdSessionSteer } = await import('@/cli/commands/session/steer');
    const output = captureConsoleJsonOutput();
    try {
      const result = cmdSessionSteer(['steer', 'sess-1', 'hello', '--from', 'worker/123', '--wait-ms', '10000', '--json'], { readCredentialsFn: async () => credentials });
      let hook: Awaited<ReturnType<typeof runForwarder>> | undefined;
      for (let attempt = 0; attempt < 50 && !additionalContextOf(hook?.stdout ?? ''); attempt += 1) {
        hook = await runForwarder(runner.port, { session_id: 'claude-main' });
      }
      expect(additionalContextOf(hook?.stdout ?? '')).toBe('[Steering from worker/123 (caller-asserted)]\nhello');
      await result;
      expect(output.json()).toMatchObject({ ok: true, data: { result: 'written_to_hook_response' } });
    } finally { output.restore(); }
  });

  it('reports no tool boundary and keeps nothing once the wait ends', async () => {
    const runner = await startClaudeRunner();
    const { steerSessionAtToolBoundary } = await load({ active: true, relay: runner.relay });
    await expect(steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'expires', waitMs: 50 }))
      .resolves.toEqual({ ok: false, sessionId: 'sess-1', code: 'no_tool_boundary' });
    expect(await runForwarder(runner.port, { session_id: 'claude-main' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('treats a lost acknowledgement as uncertain; a retry and a later message are both delivered', async () => {
    const runner = await startClaudeRunner();
    let loseNextAck = true;
    const lossyRelay: Relay = async (method, request) => {
      const reply = await runner.relay(method, request);
      if (loseNextAck) {
        loseNextAck = false;
        throw markRpcRequestDisposition(new Error('RPC call timeout'), 'outcomeUnknown');
      }
      return reply;
    };
    const { steerSessionAtToolBoundary } = await load({ active: true, relay: lossyRelay });

    const first = steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'first', waitMs: 10_000 });
    const firstHook = await runForwarder(runner.port, { session_id: 'claude-main' });
    expect(additionalContextOf(firstHook.stdout)).toBe('first');
    await expect(first).resolves.toEqual({ ok: false, sessionId: 'sess-1', code: 'delivery_uncertain' });

    // Uncertainty never strands later messages, and the duplicate retry is accepted.
    const retry = steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'first', waitMs: 10_000 });
    const later = steerSessionAtToolBoundary({ credentials, idOrPrefix: 'sess-1', message: 'second', waitMs: 10_000 });
    let settled = false;
    void Promise.all([retry, later]).then(() => { settled = true; });
    const delivered: string[] = [];
    for (let attempt = 0; attempt < 50 && !settled; attempt += 1) {
      const context = additionalContextOf((await runForwarder(runner.port, { session_id: 'claude-main' })).stdout);
      if (context) delivered.push(...context.split('\n\n'));
    }
    expect(delivered).toEqual(['first', 'second']);
    await expect(retry).resolves.toEqual({ ok: true, sessionId: 'sess-1', result: 'written_to_hook_response' });
    await expect(later).resolves.toEqual({ ok: true, sessionId: 'sess-1', result: 'written_to_hook_response' });
  });
});
