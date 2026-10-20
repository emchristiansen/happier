import { describe, expect, it, vi } from 'vitest';

import {
  probeSessionPendingQueueWakeCapabilityV1,
  requestSessionPendingQueueWakeV1,
} from './pendingQueueWake';

describe('probeSessionPendingQueueWakeCapabilityV1', () => {
  it('proves exact-session serviceability without publishing a wake', async () => {
    const callRpc = vi.fn(async (_method: string) => ({
      ok: true,
      capability: 'pending_queue_wake_v1',
      protocolVersion: 1,
      method: 'session.pendingQueue.wake.v1',
    }));

    await expect(probeSessionPendingQueueWakeCapabilityV1({
      sessionId: 'sess-live',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-live', mode: 'socket', ctx: {} }),
      callRpc,
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ state: 'servable' });
    expect(callRpc).toHaveBeenCalledOnce();
    expect(callRpc.mock.calls[0]?.[0]).toBe('sess-live:session.pendingQueue.wakeCapability.v1.get');
  });

  it('distinguishes a definitively unsupported live runtime from transport uncertainty', async () => {
    const base = {
      sessionId: 'sess-live',
      token: 'token',
      resolveTransport: async () => ({ ok: true as const, sessionId: 'sess-live', mode: 'socket', ctx: {} }),
      isMethodUnavailable: (error: unknown) => (error as { code?: string }).code === 'RPC_METHOD_NOT_AVAILABLE',
    };

    await expect(probeSessionPendingQueueWakeCapabilityV1({
      ...base,
      callRpc: async () => { throw Object.assign(new Error('missing'), { code: 'RPC_METHOD_NOT_AVAILABLE' }); },
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' });
    await expect(probeSessionPendingQueueWakeCapabilityV1({
      ...base,
      callRpc: async () => { throw new Error('socket reset'); },
    })).resolves.toEqual({ state: 'unknown', reason: 'rpc_failed' });
  });

  it('preserves a terminating runtime as a wait-for-exit serviceability result', async () => {
    await expect(probeSessionPendingQueueWakeCapabilityV1({
      sessionId: 'sess-terminating',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-terminating', mode: 'socket', ctx: {} }),
      callRpc: async () => ({
        ok: false,
        error: 'pending_materialization_wake_unavailable',
        errorCode: 'runtime_terminating',
      }),
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'runtime_terminating' });
  });

  it('carries a runner-reported lost publisher with the incarnation that reported it', async () => {
    const respondent = { machineId: 'machine-1', pid: 4242, processInstanceFingerprint: 'linux-proc:991' };
    await expect(probeSessionPendingQueueWakeCapabilityV1({
      sessionId: 'sess-wedged',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-wedged', mode: 'socket', ctx: {} }),
      callRpc: async () => ({
        ok: false,
        error: 'pending_materialization_wake_unavailable',
        errorCode: 'publisher_lost',
        respondent,
      }),
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'publisher_lost', respondent });
  });

  it.each([
    ['missing', {}],
    ['partial', { respondent: { machineId: 'machine-1', pid: 4242 } }],
    ['malformed', { respondent: { machineId: 'machine-1', pid: '4242', processInstanceFingerprint: 'linux-proc:991' } }],
  ])('keeps a lost-publisher report with a %s respondent unbound', async (_label, extra) => {
    await expect(probeSessionPendingQueueWakeCapabilityV1({
      sessionId: 'sess-wedged',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-wedged', mode: 'socket', ctx: {} }),
      callRpc: async () => ({
        ok: false,
        error: 'pending_materialization_wake_unavailable',
        errorCode: 'publisher_lost',
        ...extra,
      }),
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'publisher_lost_respondent_unbound' });
  });

  it('carries a runner still recovering its publisher as its own unservable reason', async () => {
    await expect(probeSessionPendingQueueWakeCapabilityV1({
      sessionId: 'sess-recovering',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-recovering', mode: 'socket', ctx: {} }),
      callRpc: async () => ({
        ok: false,
        error: 'pending_materialization_wake_unavailable',
        errorCode: 'publisher_recovering',
      }),
      isMethodUnavailable: () => false,
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'publisher_recovering' });
  });
});

describe('requestSessionPendingQueueWakeV1', () => {
  it('never falls back to the legacy mutating method when discovery is unavailable', async () => {
    const calls: string[] = [];
    const callRpc = vi.fn(async (method: string) => {
      calls.push(method);
      throw Object.assign(new Error('method unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
    });

    await expect(requestSessionPendingQueueWakeV1({
      sessionId: 'sess-old',
      token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-old', mode: 'socket', ctx: {} }),
      callRpc,
      isMethodUnavailable: () => true,
    })).resolves.toEqual({ type: 'unavailable', reason: 'rpc_method_unavailable' });
    expect(calls).toEqual(['sess-old:session.pendingQueue.wakeCapability.v1.get']);
    expect(calls.join(' ')).not.toContain('materializeNext');
  });

  it('discovers before publishing a strict wake', async () => {
    const calls: Array<{ method: string; request: unknown }> = [];
    const callRpc = vi.fn(async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method.endsWith('wakeCapability.v1.get')) return {
        ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1',
      };
      return { ok: true, result: 'wake_published' };
    });

    await expect(requestSessionPendingQueueWakeV1({
      sessionId: 'sess-new', token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-new', mode: 'socket', ctx: {} }),
      callRpc, isMethodUnavailable: () => false,
    })).resolves.toEqual({ type: 'wake_published' });
    expect(calls).toEqual([
      { method: 'sess-new:session.pendingQueue.wakeCapability.v1.get', request: {} },
      { method: 'sess-new:session.pendingQueue.wake.v1', request: { protocolVersion: 1 } },
    ]);
  });

  it('keeps a missing generic wake method classified as method unavailable', async () => {
    const callRpc = vi.fn(async (method: string) => {
      if (method.endsWith('wakeCapability.v1.get')) {
        return { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' };
      }
      throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    });

    await expect(requestSessionPendingQueueWakeV1({
      sessionId: 'sess-wake-race', token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-wake-race', mode: 'socket', ctx: {} }),
      callRpc,
      isMethodUnavailable: (error) => (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'RPC_METHOD_NOT_AVAILABLE',
    })).resolves.toEqual({ type: 'unavailable', reason: 'rpc_method_unavailable' });
  });

});


describe('requestSessionPendingQueueWakeV1 shutdown and malformed responses', () => {
  it('fails closed on malformed discovery without wake or legacy fallback', async () => {
    const callRpc = vi.fn(async () => ({
      ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1,
      method: 'session.pendingQueue.materializeNext',
    }));
    await expect(requestSessionPendingQueueWakeV1({
      sessionId: 'sess-malformed', token: 'token',
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-malformed', mode: 'socket', ctx: {} }),
      callRpc, isMethodUnavailable: () => false,
    })).resolves.toEqual({ type: 'unavailable', reason: 'malformed_response' });
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it('does not publish a wake when shutdown begins while capability discovery is in flight', async () => {
    let resolveCapability!: (value: unknown) => void;
    const capability = new Promise<unknown>((resolve) => {
      resolveCapability = resolve;
    });
    let shutdownRequested = false;
    const calls: string[] = [];
    const callRpc = vi.fn(async (method: string) => {
      calls.push(method);
      if (method.endsWith('wakeCapability.v1.get')) return await capability;
      return { ok: true, result: 'wake_published' };
    });

    const result = requestSessionPendingQueueWakeV1({
      sessionId: 'sess-shutdown', token: 'token',
      isShutdownRequested: () => shutdownRequested,
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-shutdown', mode: 'socket', ctx: {} }),
      callRpc, isMethodUnavailable: () => false,
    });
    await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1));
    shutdownRequested = true;
    resolveCapability({
      ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1',
    });

    await expect(result).resolves.toEqual({ type: 'unavailable', reason: 'shutdown' });
    expect(calls).toEqual(['sess-shutdown:session.pendingQueue.wakeCapability.v1.get']);
  });

  it('observes shutdown before interpreting an in-flight capability response', async () => {
    let resolveCapability!: (value: unknown) => void;
    const capability = new Promise<unknown>((resolve) => {
      resolveCapability = resolve;
    });
    let shutdownRequested = false;
    const callRpc = vi.fn(async () => await capability);

    const result = requestSessionPendingQueueWakeV1({
      sessionId: 'sess-shutdown-malformed', token: 'token',
      isShutdownRequested: () => shutdownRequested,
      resolveTransport: async () => ({ ok: true, sessionId: 'sess-shutdown-malformed', mode: 'socket', ctx: {} }),
      callRpc, isMethodUnavailable: () => false,
    });
    await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1));
    shutdownRequested = true;
    resolveCapability({ ok: true, capability: 'unexpected' });

    await expect(result).resolves.toEqual({ type: 'unavailable', reason: 'shutdown' });
    expect(callRpc).toHaveBeenCalledTimes(1);
  });
});
