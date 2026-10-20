import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('registerSessionHandlers pending queue materialization', () => {
  it('keeps the legacy method side-effect-free for old daemons', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd());

    expect(handlers.has(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)).toBe(true);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)?.({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({
      ok: true,
      didMaterialize: false,
      result: { type: 'deferred', reason: 'runtime_upgrade_required' },
    });
  });

  it('keeps the legacy method side-effect-free when unrelated controls exist', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)?.({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({
      ok: true,
      didMaterialize: false,
      result: { type: 'deferred', reason: 'runtime_upgrade_required' },
    });
  });

  it('discovers and publishes only the versioned wake operation', async () => {
    const { handlers, registrar } = createRegistrar();
    const wakePendingMaterialization = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: { wakePendingMaterialization },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)?.({})).resolves.toEqual({
      ok: true,
      capability: 'pending_queue_wake_v1',
      protocolVersion: 1,
      method: SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1,
    });
    expect(wakePendingMaterialization).not.toHaveBeenCalled();

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1)?.({ protocolVersion: 1 })).resolves.toEqual({
      ok: true,
      result: 'wake_published',
    });
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(1);
  });

  const respondent = { machineId: 'machine-1', pid: 4242, processInstanceFingerprint: 'linux-proc:991' };
  it.each([
    ['runtime_terminating', { state: 'unservable', reason: 'runtime_terminating' }, {}],
    ['publisher_recovering', { state: 'unservable', reason: 'publisher_recovering' }, {}],
    ['publisher_lost', { state: 'unservable', reason: 'publisher_lost', respondent }, { respondent }],
    ['unidentified publisher_lost', { state: 'unservable', reason: 'publisher_lost', respondent: null }, {}],
  ] as const)('reports a %s runtime before accepting wake work', async (_label, serviceability, extra) => {
    const { handlers, registrar } = createRegistrar();
    const wakePendingMaterialization = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        readPendingMaterializationServiceability: () => serviceability,
        wakePendingMaterialization,
      },
    });

    const unavailable = {
      ok: false,
      error: 'pending_materialization_wake_unavailable',
      errorCode: serviceability.reason,
      ...extra,
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)?.({}))
      .resolves.toStrictEqual(unavailable);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1)?.({ protocolVersion: 1 }))
      .resolves.toStrictEqual(unavailable);
    expect(wakePendingMaterialization).not.toHaveBeenCalled();
  });

  it('rejects malformed wake requests without publishing', async () => {
    const { handlers, registrar } = createRegistrar();
    const wakePendingMaterialization = vi.fn();
    registerSessionHandlers(registrar, process.cwd(), { sessionRuntimeControls: { wakePendingMaterialization } });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1)?.({
      protocolVersion: 1,
      didMaterialize: false,
    })).rejects.toBeDefined();
    expect(wakePendingMaterialization).not.toHaveBeenCalled();
  });

});
