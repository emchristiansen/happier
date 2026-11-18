import {
  SessionToolBoundarySteerRequestV1Schema,
  type SessionToolBoundarySteerResponseV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { SessionRuntimeControls } from './sessionControls';

/**
 * Steering without durable Pending custody. A runner whose provider has no tool-boundary broker
 * refuses rather than queueing; older runners do not register the method at all.
 */
export function registerSessionToolBoundarySteerHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{ sessionRuntimeControls?: Pick<SessionRuntimeControls, 'steerAtToolBoundary'> | null }>,
): void {
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_TOOL_BOUNDARY_STEER_V1, async (
    raw: unknown,
    _legacyLocalOptions?: undefined,
    context?: RpcHandlerContext,
  ): Promise<SessionToolBoundarySteerResponseV1> => {
    const request = SessionToolBoundarySteerRequestV1Schema.parse(raw);
    const steer = opts.sessionRuntimeControls?.steerAtToolBoundary;
    if (typeof steer !== 'function') return { ok: false, errorCode: 'steering_unavailable' };
    // Caller cancellation and transport loss withdraw an offer no hook has taken yet.
    const outcome = await steer({
      message: request.message,
      waitMs: request.waitMs,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return outcome === 'written_to_hook_response'
      ? { ok: true, result: outcome }
      : { ok: false, errorCode: outcome };
  });
}
