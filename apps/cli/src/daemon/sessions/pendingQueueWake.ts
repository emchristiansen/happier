import {
  SessionPendingQueueWakeCapabilityResponseV1Schema,
  SessionPendingQueueWakeResponseV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type SessionPendingQueueWakeDiagnostic =
  | Readonly<{ type: 'wake_published' }>
  | Readonly<{
      type: 'unavailable';
      reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'session_mismatch' | 'rpc_method_unavailable' | 'runtime_upgrade_required' | 'runtime_terminating' | 'publisher_lost' | 'malformed_response' | 'rpc_failed';
    }>;

type TransportResult =
  | Readonly<{ ok: true; sessionId: string; mode: unknown; ctx: unknown }>
  | Readonly<{ ok: false }>;

export type SessionRunnerServiceability =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: 'session_mismatch' | 'rpc_method_unavailable' | 'runtime_upgrade_required' | 'runtime_terminating' | 'publisher_lost' | 'malformed_response' }>
  | Readonly<{ state: 'unknown'; reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'rpc_failed' }>;

type CapabilityProbeParams = Readonly<{
  sessionId: string;
  token: string;
  isShutdownRequested?: () => boolean;
  resolveTransport: () => Promise<TransportResult>;
  callRpc: (method: string, request: unknown, transport: Readonly<{ mode: unknown; ctx: unknown }>) => Promise<unknown>;
  isMethodUnavailable: (error: unknown) => boolean;
}>;

type CapabilityDiscovery =
  | Readonly<{ result: Extract<SessionRunnerServiceability, { state: 'servable' }>; transport: Extract<TransportResult, { ok: true }> }>
  | Readonly<{ result: Exclude<SessionRunnerServiceability, { state: 'servable' }> }>;

async function discoverSessionPendingQueueWakeCapabilityV1(params: CapabilityProbeParams): Promise<CapabilityDiscovery> {
  if (params.isShutdownRequested?.()) return { result: { state: 'unknown', reason: 'shutdown' } };
  if (!params.token.trim()) return { result: { state: 'unknown', reason: 'no_token' } };
  const transport = await params.resolveTransport();
  if (!transport.ok) return { result: { state: 'unknown', reason: 'transport_unavailable' } };
  if (transport.sessionId !== params.sessionId) {
    return { result: { state: 'recoverable_unservable', reason: 'session_mismatch' } };
  }
  if (params.isShutdownRequested?.()) return { result: { state: 'unknown', reason: 'shutdown' } };
  try {
    const raw = await params.callRpc(
      `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
      {},
      transport,
    );
    if (params.isShutdownRequested?.()) return { result: { state: 'unknown', reason: 'shutdown' } };
    const capability = SessionPendingQueueWakeCapabilityResponseV1Schema.safeParse(raw);
    if (!capability.success || (capability.data.ok && capability.data.method !== SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1)) {
      return { result: { state: 'recoverable_unservable', reason: 'malformed_response' } };
    }
    if (!capability.data.ok) {
      return { result: { state: 'recoverable_unservable', reason: capability.data.errorCode } };
    }
    return { result: { state: 'servable' }, transport };
  } catch (error) {
    return params.isMethodUnavailable(error)
      ? { result: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' } }
      : { result: { state: 'unknown', reason: 'rpc_failed' } };
  }
}

/** Pure serviceability probe: capability discovery only, never publishes a wake. */
export async function probeSessionPendingQueueWakeCapabilityV1(params: CapabilityProbeParams): Promise<SessionRunnerServiceability> {
  return (await discoverSessionPendingQueueWakeCapabilityV1(params)).result;
}

export async function requestSessionPendingQueueWakeV1(params: Readonly<{
  sessionId: string;
  token: string;
  isShutdownRequested?: () => boolean;
  resolveTransport: () => Promise<TransportResult>;
  callRpc: (method: string, request: unknown, transport: Readonly<{ mode: unknown; ctx: unknown }>) => Promise<unknown>;
  isMethodUnavailable: (error: unknown) => boolean;
}>): Promise<SessionPendingQueueWakeDiagnostic> {
  const discovery = await discoverSessionPendingQueueWakeCapabilityV1(params);
  if (!('transport' in discovery)) {
    return { type: 'unavailable', reason: discovery.result.reason };
  }
  const transport = discovery.transport;

  try {
    const wakeRaw = await params.callRpc(
      `${params.sessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`,
      {
        protocolVersion: 1,
      },
      transport,
    );
    const wake = SessionPendingQueueWakeResponseV1Schema.safeParse(wakeRaw);
    if (!wake.success) return { type: 'unavailable', reason: 'malformed_response' };
    if (!wake.data.ok) return { type: 'unavailable', reason: wake.data.errorCode };
    return { type: 'wake_published' };
  } catch (error) {
    return { type: 'unavailable', reason: params.isMethodUnavailable(error) ? 'rpc_method_unavailable' : 'rpc_failed' };
  }
}
