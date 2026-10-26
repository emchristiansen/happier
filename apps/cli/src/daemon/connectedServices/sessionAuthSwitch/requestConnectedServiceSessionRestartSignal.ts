import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from '../diagnostics/connectedServiceUxDiagnostics';

export type ConnectedServiceDaemonRestartTrigger =
  | 'manual_switch'
  | 'automatic_group_switch'
  | 'refresh_triggered_restart'
  | 'runtime_auth_recovery_restart'
  | 'usage_limit_recovery'
  | 'reconnect_propagation';

export type ConnectedServiceDaemonRestartDiagnosticStatus =
  | 'requested'
  | 'process_already_missing'
  | 'signal_failed'
  | 'skipped_stale_owner'
  | 'duplicate_restart_suppressed'
  | 'terminal_restart_suppressed';

export type ConnectedServiceSessionRestartSignalResult = Readonly<{
  status:
    | 'requested'
    | 'process_already_missing'
    | 'skipped_stale_owner'
    | 'skipped_duplicate_restart'
    | 'skipped_terminal_restart';
}>;

export type ConnectedServiceRestartRequestedTranscriptEventOwner = 'switch_fsm' | 'restart_signal';

export function shouldEmitConnectedServiceRestartRequestedSessionEvent(input: Readonly<{
  owner: ConnectedServiceRestartRequestedTranscriptEventOwner;
  signaled: boolean;
}>): boolean {
  // A switch attempt already has one canonical FSM event author. Direct refresh/recovery restart
  // signals do not, so their signal owner remains responsible for the request-level transcript fact.
  return input.signaled && input.owner === 'restart_signal';
}

export type ConnectedServiceDaemonRestartDiagnosticInput = Readonly<{
  trigger: ConnectedServiceDaemonRestartTrigger;
  sessionId?: string | null;
  agentId?: string | null;
  serviceId?: string | null;
  profileId?: string | null;
  groupId?: string | null;
  generation?: number | null;
  reason?: string | null;
}>;

export type ConnectedServiceDaemonRestartDiagnosticRecord = Readonly<{
  type: 'connected_service_daemon_restart';
  trigger: ConnectedServiceDaemonRestartTrigger;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  sessionId: string | null;
  agentId: string | null;
  serviceId: string | null;
  profileId: string | null;
  groupId: string | null;
  generation: number | null;
  reason: string | null;
  pid: number | null;
  processGroupPid: number | null;
  delayMs: number | null;
  atMs: number;
}>;

export type ConnectedServiceDaemonRestartDiagnosticRecorder = (
  record: ConnectedServiceDaemonRestartDiagnosticRecord,
) => void;

export type ConnectedServiceSessionRestartAmplificationGuard = Readonly<{
  reserve: (input: Readonly<{
    pid: number;
    diagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
  }>) => Readonly<{ status: 'reserved' | 'not_guarded' } | { status: 'duplicate' | 'terminal' }>;
  completePid: (
    pid: number,
    outcome: Readonly<
      | { status: 'success' | 'cleared' }
      | { status: 'terminal'; reason: string }
    >,
  ) => void;
  transferPid: (fromPid: number, toPid: number) => void;
}>;

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function buildConnectedServiceRestartRequestedSessionEvent(
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput,
): Readonly<{
  type: 'connected_service_account_switch_attempt';
  ok: true;
  action: 'restart_requested';
  reason: string;
  attemptedContinuityMode: 'restart';
  outcome: 'observed';
  outcomeAction: 'none';
  errorCode: null;
  groupGeneration?: number;
  partialState: null;
  diagnostic: ReturnType<typeof buildConnectedServiceUxDiagnostic>;
}> {
  const trigger = diagnostic.trigger;
  const rawReason = normalizeString(diagnostic.reason) ?? trigger;
  const generation = normalizeNumber(diagnostic.generation);
  const serviceId = normalizeString(diagnostic.serviceId);
  const agentId = normalizeString(diagnostic.agentId);
  const profileId = normalizeString(diagnostic.profileId);
  const groupId = normalizeString(diagnostic.groupId);
  return {
    type: 'connected_service_account_switch_attempt',
    ok: true,
    action: 'restart_requested',
    reason: trigger,
    attemptedContinuityMode: 'restart',
    // A successful signal request is not proof that the process stopped or that a replacement
    // adopted the target. The process supervisor emits those later facts independently.
    outcome: 'observed',
    outcomeAction: 'none',
    errorCode: null,
    ...(generation === null ? {} : { groupGeneration: generation }),
    partialState: null,
    diagnostic: buildConnectedServiceUxDiagnostic({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceRestartRequested,
      failurePhase: 'restart',
      source: 'transcript_switch_attempt',
      ...(serviceId ? { serviceId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(groupId ? { groupId } : {}),
      retryable: true,
      diagnostics: {
        trigger,
        reason: rawReason,
        ...(generation === null ? {} : { groupGeneration: generation }),
      },
    }),
  };
}

function buildAuthRecoveryRestartGuardKey(
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput,
): string | null {
  if (diagnostic.trigger !== 'runtime_auth_recovery_restart') return null;
  const sessionId = normalizeString(diagnostic.sessionId);
  const serviceId = normalizeString(diagnostic.serviceId);
  if (!sessionId || !serviceId) return null;
  const generation = normalizeNumber(diagnostic.generation);
  return [
    sessionId,
    serviceId,
    generation === null ? 'generation:none' : `generation:${generation}`,
  ].join('|');
}

export function createConnectedServiceSessionRestartAmplificationGuard(): ConnectedServiceSessionRestartAmplificationGuard {
  const outstandingKeys = new Set<string>();
  const terminalKeys = new Set<string>();
  const keyByPid = new Map<number, string>();

  return {
    reserve: ({ pid, diagnostic }) => {
      const key = buildAuthRecoveryRestartGuardKey(diagnostic);
      if (!key) return { status: 'not_guarded' };
      if (terminalKeys.has(key)) return { status: 'terminal' };
      if (outstandingKeys.has(key)) return { status: 'duplicate' };
      outstandingKeys.add(key);
      keyByPid.set(pid, key);
      return { status: 'reserved' };
    },
    completePid: (pid, outcome) => {
      const key = keyByPid.get(pid);
      if (!key) return;
      keyByPid.delete(pid);
      outstandingKeys.delete(key);
      if (outcome.status === 'terminal' && outcome.reason === 'not_authenticated') {
        terminalKeys.add(key);
      }
    },
    transferPid: (fromPid, toPid) => {
      const key = keyByPid.get(fromPid);
      if (!key) return;
      keyByPid.delete(fromPid);
      keyByPid.set(toPid, key);
    },
  };
}

export function buildConnectedServiceDaemonRestartDiagnosticRecord(input: Readonly<{
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  pid?: number | null;
  processGroupPid?: number | null;
  delayMs?: number | null;
  atMs: number;
}>): ConnectedServiceDaemonRestartDiagnosticRecord {
  return {
    type: 'connected_service_daemon_restart',
    trigger: input.diagnostic.trigger,
    status: input.status,
    sessionId: normalizeString(input.diagnostic.sessionId),
    agentId: normalizeString(input.diagnostic.agentId),
    serviceId: normalizeString(input.diagnostic.serviceId),
    profileId: normalizeString(input.diagnostic.profileId),
    groupId: normalizeString(input.diagnostic.groupId),
    generation: normalizeNumber(input.diagnostic.generation),
    reason: normalizeString(input.diagnostic.reason),
    pid: normalizeNumber(input.pid),
    processGroupPid: normalizeNumber(input.processGroupPid),
    delayMs: normalizeNumber(input.delayMs),
    atMs: Math.trunc(input.atMs),
  };
}

export function recordConnectedServiceDaemonRestartDiagnostic(input: Readonly<{
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  pid?: number | null;
  processGroupPid?: number | null;
  delayMs?: number | null;
  nowMs: () => number;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
}>): void {
  input.recordRestartDiagnostic?.(buildConnectedServiceDaemonRestartDiagnosticRecord({
    diagnostic: input.diagnostic,
    status: input.status,
    pid: input.pid ?? null,
    processGroupPid: input.processGroupPid ?? null,
    delayMs: input.delayMs ?? null,
    atMs: input.nowMs(),
  }));
}

export function isConnectedServiceRestartSignalStaleProcessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ESRCH') return true;
  return /\bESRCH\b|\bno such process\b/i.test(error.message);
}

export async function requestConnectedServiceSessionRestartSignal(params: Readonly<{
  pid: number;
  processGroupPid?: number | null;
  delayMs: number;
  shouldSignal?: () => boolean | Promise<boolean>;
  /** Synchronous daemon lifetime check, including after the final asynchronous authority check. */
  isShutdownRequested?: () => boolean;
  onSignalFailure: (error: unknown) => void;
  onProcessAlreadyMissing?: () => void;
  restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
  restartAmplificationGuard?: ConnectedServiceSessionRestartAmplificationGuard;
  nowMs?: () => number;
}>): Promise<ConnectedServiceSessionRestartSignalResult> {
  const nowMs = params.nowMs ?? Date.now;
  const recordDiagnostic = (status: ConnectedServiceDaemonRestartDiagnosticStatus) => {
    if (!params.restartDiagnostic) return;
    recordConnectedServiceDaemonRestartDiagnostic({
      diagnostic: params.restartDiagnostic,
      status,
      pid: params.pid,
      processGroupPid: params.processGroupPid ?? null,
      delayMs: params.delayMs,
      nowMs,
      recordRestartDiagnostic: params.recordRestartDiagnostic,
    });
  };

  const signal = async (): Promise<ConnectedServiceSessionRestartSignalResult> => {
    if (params.isShutdownRequested?.()) {
      recordDiagnostic('skipped_stale_owner');
      return { status: 'skipped_stale_owner' };
    }
    if (params.shouldSignal && !await params.shouldSignal()) {
      recordDiagnostic('skipped_stale_owner');
      return { status: 'skipped_stale_owner' };
    }
    // Awaiting even an already-fulfilled authority result yields. Shutdown may begin before this
    // continuation resumes; keep the final lifetime check synchronous with the signal below.
    if (params.isShutdownRequested?.()) {
      recordDiagnostic('skipped_stale_owner');
      return { status: 'skipped_stale_owner' };
    }
    const reservation = params.restartDiagnostic
      ? params.restartAmplificationGuard?.reserve({ pid: params.pid, diagnostic: params.restartDiagnostic })
      : null;
    if (reservation?.status === 'duplicate') {
      recordDiagnostic('duplicate_restart_suppressed');
      return { status: 'skipped_duplicate_restart' };
    }
    if (reservation?.status === 'terminal') {
      recordDiagnostic('terminal_restart_suppressed');
      return { status: 'skipped_terminal_restart' };
    }
    recordDiagnostic('requested');
    if (
      typeof params.processGroupPid === 'number' &&
      Number.isInteger(params.processGroupPid) &&
      params.processGroupPid > 0
    ) {
      try {
        process.kill(-params.processGroupPid, 'SIGTERM');
        return { status: 'requested' };
      } catch {
        // Fall back to the tracked process below. Some platforms do not support process groups.
      }
    }
    try {
      process.kill(params.pid, 'SIGTERM');
      return { status: 'requested' };
    } catch (error) {
      if (isConnectedServiceRestartSignalStaleProcessError(error)) {
        params.restartAmplificationGuard?.completePid(params.pid, { status: 'cleared' });
        recordDiagnostic('process_already_missing');
        params.onProcessAlreadyMissing?.();
        return { status: 'process_already_missing' };
      }
      params.restartAmplificationGuard?.completePid(params.pid, { status: 'cleared' });
      recordDiagnostic('signal_failed');
      params.onSignalFailure(error);
      throw error;
    }
  };

  if (params.delayMs <= 0) {
    return await signal();
  }

  return await new Promise<ConnectedServiceSessionRestartSignalResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        void signal().then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    }, params.delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
  });
}
