import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import { readSessionRunnerLockStatus, type SessionRunnerLockStatus } from '../sessionRunnerLock';
import {
  classifySessionRunnerProcessPresence,
  isValidProcessCommandHash,
  readSessionRunnerProcessIdentity,
  type SessionRunnerProcessCommandHashReader,
  type SessionRunnerProcessInstanceFingerprintReader,
  type SessionRunnerProcessPresence,
} from '../sessionRunnerProcessIdentity';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';
import type { SessionRunnerIncarnation, SessionRunnerServiceability } from './pendingQueueWake';

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function trackedSessionMatchesSessionId(tracked: TrackedSession, sessionId: string): boolean {
  const trackedHappySessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  const trackedExistingSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  return trackedHappySessionId === sessionId || trackedExistingSessionId === sessionId;
}

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;

async function classifyStoredProcessPresence(params: {
  storedProcessCommandHash: string | null | undefined;
  storedProcessInstanceFingerprint: string | null | undefined;
  pid: number;
  runState: ProcessRunState | null;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  const hasStoredIdentity = isValidProcessCommandHash(params.storedProcessCommandHash)
    || Boolean(params.storedProcessInstanceFingerprint);
  const currentIdentity = hasStoredIdentity && params.runState !== 'dead' && params.runState !== 'zombie'
    ? await readSessionRunnerProcessIdentity({
        pid: params.pid,
        getProcessCommandHash: params.getProcessCommandHash,
        getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
      })
    : undefined;
  return classifySessionRunnerProcessPresence({
    runState: params.runState,
    storedProcessCommandHash: params.storedProcessCommandHash,
    storedProcessInstanceFingerprint: params.storedProcessInstanceFingerprint,
    currentIdentity,
  });
}

async function classifyLockPresence(params: {
  sessionId: string;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<SessionRunnerProcessPresence> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status) return 'unknown';
  if (!status.ok) return status.reason === 'not_found' ? 'absent' : 'unknown';

  const pid = status.lock.pid;
  const runState = await params.readProcessRunState(pid).catch(() => null);
  return await classifyStoredProcessPresence({
    storedProcessCommandHash: status.lock.processCommandHash,
    storedProcessInstanceFingerprint: status.lock.processInstanceFingerprint,
    pid,
    runState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
  });
}

export async function classifyTrackedSessionRunnerPresence(params: {
  tracked: TrackedSession;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  // A Windows Terminal dispatcher can exit before the runner reports. Its
  // lifetime is not evidence of runner absence; the existing startup finalizer
  // owns failure/timeout until a correlated runner identity is available.
  if (params.tracked.hostedTerminal?.mode === 'windows_terminal'
    && params.tracked.startupCustody
    && !params.tracked.sessionRunnerPid
    && !params.tracked.happySessionMetadataFromLocalWebhook
    && params.tracked.stopRequestedAtMs === undefined) return 'unknown';
  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = params.tracked.sessionRunnerPid ?? childPid ?? params.tracked.pid;
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const runState = await readProcessRunState(pidToCheck).catch(() => null);
  return await classifyStoredProcessPresence({
    storedProcessCommandHash: params.tracked.processCommandHash,
    storedProcessInstanceFingerprint: params.tracked.processInstanceFingerprint,
    pid: pidToCheck,
    runState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
  });
}

export async function isSessionRunnerActive(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of params.trackedSessions) {
    if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
    if (await classifyTrackedSessionRunnerPresence({
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    }) === 'present') {
      return true;
    }
  }

  return await classifyLockPresence({
    sessionId,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  }) === 'present';
}

declare const matchedLostPublisherRunnerBrand: unique symbol;

/**
 * The exact local runner incarnation that itself reported `publisher_lost`. Only
 * `bindLostPublisherReport` constructs one, after proving the respondent equals the one local process
 * a Stop of the session would signal, so a `replace` decision always carries its matched target.
 */
export type MatchedLostPublisherRunner = SessionRunnerIncarnation & Readonly<{ [matchedLostPublisherRunnerBrand]: true }>;

/** Runner control state as seen by the daemon, after binding any lost-publisher report to a local process. */
export type SessionRunnerControl =
  | Exclude<SessionRunnerServiceability, Readonly<{ reason: 'publisher_lost' }>>
  | Readonly<{ state: 'recoverable_unservable'; reason: 'publisher_lost'; target: MatchedLostPublisherRunner }>
  /** The report may be genuine, but no single local process is provably the one Stop would signal. */
  | Readonly<{ state: 'recoverable_unservable'; reason: 'publisher_lost_target_ambiguous' }>;

export type SessionRunnerServiceabilityProbe =
  | Readonly<{ state: 'runner_absent' }>
  | Readonly<{ state: 'runner_unknown'; reason: 'runner_presence_unproven' }>
  | Readonly<{ state: 'runner_present'; control: SessionRunnerControl }>;

export type SessionRunnerResumeDecision =
  | Readonly<{ action: 'spawn' }>
  | Readonly<{ action: 'adopt' }>
  | Readonly<{
      action: 'wait_for_exit';
      reason: 'runtime_terminating' | 'rpc_method_unavailable' | 'rpc_failed';
    }>
  | Readonly<{ action: 'replace'; reason: 'publisher_lost'; target: MatchedLostPublisherRunner }>
  | Readonly<{ action: 'fence'; reason: string }>;

/**
 * The one local incarnation a session Stop would signal, or null when that is not exactly one
 * process: several tracked entries, a wrapper whose runner is another pid, lock-only presence, or an
 * unreadable machine or process instance.
 */
function resolveSoleTrackedRunnerIncarnation(params: Readonly<{
  tracked: TrackedSession;
  matchingTrackedCount: number;
  localMachineId: string | undefined;
  getProcessInstanceFingerprint: SessionRunnerProcessInstanceFingerprintReader;
}>): SessionRunnerIncarnation | null {
  if (params.matchingTrackedCount !== 1) return null;
  const pid = params.tracked.pid;
  const childPid = params.tracked.childProcess?.pid;
  if (typeof childPid === 'number' && childPid !== pid) return null;
  if (typeof params.tracked.sessionRunnerPid === 'number' && params.tracked.sessionRunnerPid !== pid) return null;
  const machineId = String(params.localMachineId ?? '').trim();
  if (!machineId) return null;
  const processInstanceFingerprint = String(params.getProcessInstanceFingerprint(pid) ?? '').trim();
  if (!processInstanceFingerprint) return null;
  return { machineId, pid, processInstanceFingerprint };
}

function bindLostPublisherReport(
  control: SessionRunnerServiceability,
  readLocalRunner: () => SessionRunnerIncarnation | null,
): SessionRunnerControl {
  if (control.state !== 'recoverable_unservable' || control.reason !== 'publisher_lost') return control;
  const local = readLocalRunner();
  if (!local) return { state: 'recoverable_unservable', reason: 'publisher_lost_target_ambiguous' };
  const respondent = control.respondent;
  // Session RPC routes to the account's last registering socket, which may be another runner for
  // this session (another home, same account). Only the exact local incarnation's report counts.
  if (
    respondent.machineId !== local.machineId
    || respondent.pid !== local.pid
    || !processInstanceFingerprintMatches(local.processInstanceFingerprint, respondent.processInstanceFingerprint)
  ) {
    return { state: 'recoverable_unservable', reason: 'publisher_lost_respondent_unbound' };
  }
  return {
    state: 'recoverable_unservable',
    reason: 'publisher_lost',
    target: { ...local } as MatchedLostPublisherRunner,
  };
}

export function resolveSessionRunnerResumeDecision(probe: SessionRunnerServiceabilityProbe): SessionRunnerResumeDecision {
  if (probe.state === 'runner_absent') return { action: 'spawn' };
  if (probe.state === 'runner_unknown') return { action: 'fence', reason: probe.reason };
  if (probe.control.state === 'servable') return { action: 'adopt' };
  if (
    probe.control.reason === 'runtime_terminating'
    || probe.control.reason === 'rpc_method_unavailable'
    || probe.control.reason === 'rpc_failed'
  ) {
    return { action: 'wait_for_exit', reason: probe.control.reason };
  }
  // Only the exact local runner's own positive report proves it can never claim Pending input again.
  // A missing, failed, malformed, foreign or unbindable report stays a fence and never implies replacement.
  if (probe.control.state === 'recoverable_unservable' && probe.control.reason === 'publisher_lost') {
    return { action: 'replace', reason: 'publisher_lost', target: probe.control.target };
  }
  return { action: 'fence', reason: probe.control.reason };
}

type SessionRunnerPresenceProbeParams = Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  /** This daemon's machine identity; without it no lost-publisher report can bind to a local runner. */
  localMachineId?: string;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>;

export type SessionRunnerPresenceProbe =
  | Readonly<{ state: 'runner_present' }>
  | Exclude<SessionRunnerServiceabilityProbe, Readonly<{ state: 'runner_present' }>>;

/** Presence admission without performing or inventing a capability RPC result. */
export async function probeSessionRunnerPresence(
  params: SessionRunnerPresenceProbeParams,
): Promise<SessionRunnerPresenceProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const matchingTracked = Array.from(params.trackedSessions)
    .filter((tracked) => trackedSessionMatchesSessionId(tracked, sessionId));
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of matchingTracked) {
    const presence = await classifyTrackedSessionRunnerPresence({
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    });
    if (presence === 'present') {
      return { state: 'runner_present' };
    }
    if (presence !== 'absent') {
      return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
  }

  const lockPresence = await classifyLockPresence({
    sessionId,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  });
  if (lockPresence === 'present') {
    return { state: 'runner_present' };
  }
  if (lockPresence === 'absent' || lockPresence === 'recoverable_stopped') {
    return { state: 'runner_absent' };
  }
  return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
}

export async function probeSessionRunnerServiceability(params: SessionRunnerPresenceProbeParams & Readonly<{
  probeCapability: () => Promise<SessionRunnerServiceability>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const trackedSessions = Array.from(params.trackedSessions);
  const presence = await probeSessionRunnerPresence({ ...params, trackedSessions });
  if (presence.state !== 'runner_present') return presence;
  const matchingTracked = trackedSessions.filter((tracked) =>
    trackedSessionMatchesSessionId(tracked, normalizeSessionId(params.sessionId)));
  const control = await params.probeCapability();
  const tracked = matchingTracked.length === 1 ? matchingTracked[0] : null;
  // Lock-only presence cannot turn an absent or unproven tracked process into
  // a replacement target. Reconfirm the tracked identity after the RPC.
  const trackedPresence = tracked && control.state === 'recoverable_unservable' && control.reason === 'publisher_lost'
    ? await classifyTrackedSessionRunnerPresence({
      tracked,
      readProcessRunState: params.readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    })
    : null;
  return {
    ...presence,
    control: bindLostPublisherReport(control, () => {
      if (!tracked || trackedPresence !== 'present') return null;
      return resolveSoleTrackedRunnerIncarnation({
        tracked,
        matchingTrackedCount: matchingTracked.length,
        localMachineId: params.localMachineId,
        getProcessInstanceFingerprint: params.getProcessInstanceFingerprint ?? readProcessInstanceFingerprintSync,
      });
    }),
  };
}
