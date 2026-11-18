import {
  SessionToolBoundarySteerResponseV1Schema,
  type SessionToolBoundarySteerRequestV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import type { Credentials } from '@/persistence';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { readRpcRequestDisposition } from '@/session/transport/rpc/rpcRequestDisposition';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

/**
 * Result of steering an active session at its next tool boundary.
 *
 * Nothing here creates durable Pending custody or resumes a runtime. `written_to_hook_response`
 * is not proof that the provider read the message. Every refusal other than `delivery_uncertain`
 * delivered nothing. `delivery_uncertain` means the runner may have written the message while its
 * reply was lost; retrying may deliver a duplicate, which is acceptable.
 */
export type SteerSessionAtToolBoundaryResult =
  | Readonly<{ ok: true; sessionId: string; result: 'written_to_hook_response' }>
  | Readonly<{
    ok: false;
    sessionId: string;
    code:
      | 'session_archived'
      | 'session_inactive'
      | 'runner_unavailable'
      | 'steering_unavailable'
      | 'no_tool_boundary'
      | 'hook_response_lost'
      | 'not_sent'
      | 'delivery_uncertain';
  }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;

export async function steerSessionAtToolBoundary(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  message: string;
  /** How long the runner may hold the message waiting for a tool boundary. */
  waitMs: number;
}>): Promise<SteerSessionAtToolBoundaryResult> {
  const target = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    requireOpenSessionDataKey: true,
  });
  if (!target.ok) {
    return { ok: false, code: target.code, ...('candidates' in target && target.candidates ? { candidates: target.candidates } : {}) };
  }
  const sessionId = target.sessionId;
  const archivedAt = (target.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) return { ok: false, sessionId, code: 'session_archived' };
  // Fail closed: an inactive session is never resumed and never receives queued input from this path.
  if (target.rawSession.active !== true) return { ok: false, sessionId, code: 'session_inactive' };

  const request: SessionToolBoundarySteerRequestV1 = { protocolVersion: 1, message: params.message, waitMs: params.waitMs };
  let raw: unknown;
  try {
    raw = await callSessionRpc({
      token: params.credentials.token,
      sessionId,
      mode: target.mode,
      ctx: target.ctx,
      method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_TOOL_BOUNDARY_STEER_V1}`,
      request,
      // The runner answers by `waitMs`; the reply also needs the existing control-socket allowance.
      timeoutMs: params.waitMs + resolveSessionControlSocketConnectTimeoutMs(),
    });
  } catch (error) {
    // No runner registered the method: the session went inactive, or its runner predates steering.
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
      return { ok: false, sessionId, code: 'runner_unavailable' };
    }
    return {
      ok: false,
      sessionId,
      code: readRpcRequestDisposition(error) === 'notSent' ? 'not_sent' : 'delivery_uncertain',
    };
  }

  const parsed = SessionToolBoundarySteerResponseV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, sessionId, code: 'delivery_uncertain' };
  if (parsed.data.ok) return { ok: true, sessionId, result: parsed.data.result };
  return { ok: false, sessionId, code: parsed.data.errorCode };
}
