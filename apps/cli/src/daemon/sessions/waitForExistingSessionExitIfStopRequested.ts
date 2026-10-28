import type { TrackedSession } from '../types';
import type { ProcessRunState } from '../processRunState';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

type ExitObservation = Readonly<{
  reason: 'process-missing';
  code: null;
  signal: null;
}>;

function trackedSessionMatchesExistingSessionId(trackedSession: TrackedSession, sessionId: string): boolean {
  if (trackedSession.happySessionId === sessionId) return true;

  const existingSessionId =
    trackedSession.spawnOptions && typeof trackedSession.spawnOptions.existingSessionId === 'string'
      ? trackedSession.spawnOptions.existingSessionId.trim()
      : '';
  return existingSessionId === sessionId;
}

function collectStopRequestedMatchingPids(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  trackedPids?: ReadonlyArray<number>;
}>): number[] {
  const explicitTrackedPids = Array.isArray(params.trackedPids)
    ? params.trackedPids.filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)
    : [];
  if (explicitTrackedPids.length > 0) {
    return explicitTrackedPids.filter((pid) => {
      const trackedSession = params.pidToTrackedSession.get(pid);
      return !!trackedSession && trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId);
    });
  }
  const pids: number[] = [];
  for (const [pid, trackedSession] of params.pidToTrackedSession.entries()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      pids.push(pid);
    }
  }
  return pids;
}

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  timeoutMs: number;
  pollIntervalMs: number;
  trackedPids?: ReadonlyArray<number>;
  onExitObserved?: (pid: number, exit: ExitObservation) => void | Promise<void>;
}>): Promise<void> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return;

  const initialMatchingPids = collectStopRequestedMatchingPids({
    sessionId: normalizedSessionId,
    pidToTrackedSession: params.pidToTrackedSession,
    trackedPids: params.trackedPids,
  });
  if (initialMatchingPids.length === 0) return;

  // Serviceability is not death proof: paused or identity-unknown runners must retain custody.
  await waitForTrackedRunnerProcessesExit({
    runners: initialMatchingPids.map((pid) => ({ pid })),
    timeoutMs: params.timeoutMs,
    pollIntervalMs: params.pollIntervalMs,
    readRunState: params.readRunState,
    onExitObserved: params.onExitObserved,
  });
}
