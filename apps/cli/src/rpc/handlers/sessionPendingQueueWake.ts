import {
  SessionPendingQueueWakeCapabilityRequestV1Schema,
  SessionPendingQueueWakeRequestV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { PendingMaterializationServiceability, SessionRuntimeControls } from './sessionControls';

type UnservableReason = Extract<PendingMaterializationServiceability, { state: 'unservable' }>['reason'];

const unavailable = (errorCode: 'runtime_upgrade_required' | UnservableReason = 'runtime_upgrade_required') => ({
  ok: false as const,
  error: 'pending_materialization_wake_unavailable' as const,
  errorCode,
});

function unavailableForRuntimeState(
  controls: Pick<SessionRuntimeControls, 'readPendingMaterializationServiceability'> | null | undefined,
) {
  const serviceability = controls?.readPendingMaterializationServiceability?.();
  if (serviceability?.state !== 'unservable') return null;
  if (serviceability.reason !== 'publisher_lost') return unavailable(serviceability.reason);
  // The daemon may replace a runner only on a loss reported by that exact incarnation.
  return {
    ...unavailable('publisher_lost'),
    ...(serviceability.respondent ? { respondent: serviceability.respondent } : {}),
  };
}

export function registerSessionPendingQueueWakeHandlers(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    sessionRuntimeControls?: Pick<
      SessionRuntimeControls,
      'wakePendingMaterialization' | 'readPendingMaterializationServiceability'
    > | null;
  }>,
): void {
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT, async () => ({
    ok: true,
    didMaterialize: false,
    result: { type: 'deferred', reason: 'runtime_upgrade_required' },
  }));

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1, async (raw: unknown) => {
    SessionPendingQueueWakeCapabilityRequestV1Schema.parse(raw);
    const runtimeUnavailable = unavailableForRuntimeState(opts.sessionRuntimeControls);
    if (runtimeUnavailable) return runtimeUnavailable;
    if (typeof opts.sessionRuntimeControls?.wakePendingMaterialization !== 'function') return unavailable();
    return {
      ok: true as const,
      capability: 'pending_queue_wake_v1' as const,
      protocolVersion: 1 as const,
      method: SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1,
    };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1, async (raw: unknown) => {
    SessionPendingQueueWakeRequestV1Schema.parse(raw);
    const runtimeUnavailable = unavailableForRuntimeState(opts.sessionRuntimeControls);
    if (runtimeUnavailable) return runtimeUnavailable;
    if (typeof opts.sessionRuntimeControls?.wakePendingMaterialization !== 'function') return unavailable();
    opts.sessionRuntimeControls.wakePendingMaterialization();
    return { ok: true as const, result: 'wake_published' as const };
  });
}
