import {
  SessionPendingQueueWakeCapabilityResponseV1Schema,
  SessionPendingQueueWakeResponseV1Schema,
  type PendingQueueWakeRunnerIncarnationV1,
  type SessionPendingQueueWakeCapabilityResponseV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type SessionPendingQueueWakeDiagnostic =
  | Readonly<{ type: 'wake_published' }>
  | Readonly<{
      type: 'unavailable';
      reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'session_mismatch' | 'rpc_method_unavailable' | 'runtime_upgrade_required' | 'runtime_terminating' | 'publisher_recovering' | 'publisher_lost' | 'publisher_lost_respondent_unbound' | 'malformed_response' | 'rpc_failed';
    }>;

type TransportResult =
  | Readonly<{ ok: true; sessionId: string; mode: unknown; ctx: unknown }>
  | Readonly<{ ok: false }>;

/** The runtime incarnation a runner reports about itself. */
export type SessionRunnerIncarnation = PendingQueueWakeRunnerIncarnationV1;

export type SessionRunnerServiceability =
  | Readonly<{ state: 'servable' }>
  /** Terminal loss reported by the incarnation named here; whether that is the local runner is decided later. */
  | Readonly<{ state: 'recoverable_unservable'; reason: 'publisher_lost'; respondent: SessionRunnerIncarnation }>
  | Readonly<{
      state: 'recoverable_unservable';
      reason:
        | 'session_mismatch'
        | 'rpc_method_unavailable'
        | 'runtime_upgrade_required'
        | 'runtime_terminating'
        | 'publisher_recovering'
        /** A lost-publisher report whose respondent is missing, partial or malformed. */
        | 'publisher_lost_respondent_unbound'
        | 'malformed_response';
    }>
  | Readonly<{ state: 'unknown'; reason: 'no_token' | 'shutdown' | 'transport_unavailable' | 'rpc_failed' }>;

const UNBOUND_PUBLISHER_LOST: Readonly<{ state: 'recoverable_unservable'; reason: 'publisher_lost_respondent_unbound' }> = {
  state: 'recoverable_unservable',
  reason: 'publisher_lost_respondent_unbound',
};

/** A lost-publisher report whose respondent failed the strict schema still never reads as healthy or replaceable. */
function isUnparseablePublisherLostReport(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return record.ok === false
    && record.error === 'pending_materialization_wake_unavailable'
    && record.errorCode === 'publisher_lost';
}

function classifyUnavailableCapability(
  unavailable: Extract<SessionPendingQueueWakeCapabilityResponseV1, { ok: false }>,
): Exclude<SessionRunnerServiceability, { state: 'servable' } | { state: 'unknown' }> {
  if (unavailable.errorCode !== 'publisher_lost') {
    return { state: 'recoverable_unservable', reason: unavailable.errorCode };
  }
  return unavailable.respondent
    ? { state: 'recoverable_unservable', reason: 'publisher_lost', respondent: unavailable.respondent }
    : UNBOUND_PUBLISHER_LOST;
}

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
    if (!capability.success) {
      return {
        result: isUnparseablePublisherLostReport(raw)
          ? UNBOUND_PUBLISHER_LOST
          : { state: 'recoverable_unservable', reason: 'malformed_response' },
      };
    }
    if (capability.data.ok && capability.data.method !== SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1) {
      return { result: { state: 'recoverable_unservable', reason: 'malformed_response' } };
    }
    if (!capability.data.ok) {
      return { result: classifyUnavailableCapability(capability.data) };
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
