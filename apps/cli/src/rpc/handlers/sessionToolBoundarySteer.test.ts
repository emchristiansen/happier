import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Socket } from 'socket.io-client';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createClaudeToolBoundarySteering } from '@/backends/claude/utils/postToolUseSteeringBroker';
import { startHookServer, type HookServer } from '@/backends/claude/utils/startHookServer';
import { registerSessionToolBoundarySteerHandler } from './sessionToolBoundarySteer';

/**
 * Composition of the real RpcHandlerManager (its transport cancellation and disconnect
 * lifecycle), the real steering handler, the real Claude steering owner and the real HookServer.
 * Only the Socket.IO event surface is replaced.
 */

const SECRET = 'hook-secret';
const METHOD = `sess:${SESSION_RPC_METHODS.SESSION_TOOL_BOUNDARY_STEER_V1}`;

function createSocketEventBoundary() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return socket;
    }),
  };
  return {
    socket: socket as unknown as Socket,
    trigger(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

function postToolUse(port: number, sessionId: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolUse' });
    const req = request({
      host: '127.0.0.1', port, path: '/hook/session-start', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-happier-hook-output': 'json-v1',
        'x-happier-hook-secret': SECRET,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolvePromise(text));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function contextOf(text: string): string | null {
  return text.startsWith('{') ? JSON.parse(text).hookSpecificOutput.additionalContext : null;
}

describe('tool-boundary steering RPC lifecycle', () => {
  let server: HookServer | undefined;
  afterEach(() => { server?.stop(); server = undefined; });

  async function startRunner() {
    const steering = createClaudeToolBoundarySteering({ readExpectedSessionId: () => 'main' });
    const rpc = new RpcHandlerManager({ scopePrefix: 'sess', encryptionKey: null, encryptionVariant: 'plain', encryptionMode: 'plain', logger: () => {} } as unknown as ConstructorParameters<typeof RpcHandlerManager>[0]);
    const offered: string[] = [];
    // Records arrival at the runtime control so cancellation is sent after the offer exists.
    registerSessionToolBoundarySteerHandler(rpc, { sessionRuntimeControls: {
      steerAtToolBoundary: (request) => { offered.push(request.message); return steering.steerAtToolBoundary(request); },
    } });
    server = await startHookServer({ permissionHookSecret: SECRET, onSessionHook: () => {}, produceSessionHookOutput: steering.produceSessionHookOutput });
    const boundary = createSocketEventBoundary();
    rpc.onSocketConnect(boundary.socket);
    const steer = (message: string, requestId: string, waitMs = 60_000) => rpc.handleRequest({
      method: METHOD, params: { protocolVersion: 1, message, waitMs }, requestId,
    } as Parameters<typeof rpc.handleRequest>[0]);
    const offeredCount = (n: number) => vi.waitFor(() => expect(offered.length).toBeGreaterThanOrEqual(n));
    return { rpc, boundary, steer, port: server.port, offeredCount };
  }

  it('withdraws an untaken message when the caller cancels, releasing the handler before its deadline', async () => {
    const runner = await startRunner();
    const cancelled = runner.steer('CANCELLED', '4d9ed558-c963-408c-bfba-e61600cf0636');
    await runner.offeredCount(1);
    runner.boundary.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: '4d9ed558-c963-408c-bfba-e61600cf0636' });
    expect(await cancelled).toEqual({ ok: false, errorCode: 'no_tool_boundary' });
    expect(contextOf(await postToolUse(runner.port, 'main'))).toBeNull();
  });

  it('withdraws an untaken message when the runner transport disconnects', async () => {
    const runner = await startRunner();
    const pending = runner.steer('DISCONNECTED', 'f84acbc1-2f65-43ee-ac0b-f67d35518453');
    await runner.offeredCount(1);
    runner.rpc.onSocketDisconnect();
    expect(await pending).toEqual({ ok: false, errorCode: 'no_tool_boundary' });
    expect(contextOf(await postToolUse(runner.port, 'main'))).toBeNull();
  });

  it('keeps a message bound to the response that already took it when the caller cancels afterwards', async () => {
    const runner = await startRunner();
    const requestId = '0b5d2b7e-8f0e-4b8b-9d55-3f3f4a7e6c11';
    const taken = runner.steer('TAKEN', requestId);
    await runner.offeredCount(1);
    expect(contextOf(await postToolUse(runner.port, 'main'))).toBe('TAKEN');
    runner.boundary.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId });
    expect(await taken).toEqual({ ok: true, result: 'written_to_hook_response' });
  });

  it('expires at the caller deadline and keeps later and duplicate messages independent of a cancelled one', async () => {
    const runner = await startRunner();
    expect(await runner.steer('EXPIRES', '7c2b1d36-5a4e-4f3b-8e21-9a0c6d5e4f01', 30)).toEqual({ ok: false, errorCode: 'no_tool_boundary' });

    const cancelledId = '1e9f8a7b-6c5d-4e3f-a2b1-c0d9e8f7a6b5';
    const cancelled = runner.steer('UNCERTAIN', cancelledId);
    await runner.offeredCount(2);
    runner.boundary.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: cancelledId });
    expect(await cancelled).toEqual({ ok: false, errorCode: 'no_tool_boundary' });
    // The caller retries the same text alongside a later message; both arrive at the next boundary.
    const retry = runner.steer('UNCERTAIN', '2f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a');
    const later = runner.steer('LATER', '3a9b8c7d-6e5f-4a1b-9c2d-8e7f6a5b4c3d');
    await runner.offeredCount(4);
    expect(contextOf(await postToolUse(runner.port, 'main'))).toBe('UNCERTAIN\n\nLATER');
    expect(await retry).toEqual({ ok: true, result: 'written_to_hook_response' });
    expect(await later).toEqual({ ok: true, result: 'written_to_hook_response' });
  });
});
