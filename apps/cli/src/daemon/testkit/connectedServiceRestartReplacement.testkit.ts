import { vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createConnectedServiceSwitchDeferralQueue, type ConnectedServiceSwitchTarget } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { createRestartCompletionWaiters } from '@/daemon/plannedRunnerRestart/completionWaiters';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { createSessionRunnerRespawnManager } from '@/daemon/processSupervision/sessionRunnerRespawn';
import { resolveRespawnSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveRespawnSessionRuntimeSnapshot';

/**
 * The daemon's connected-service restart composition (startDaemon restartSession ->
 * requestConnectedServiceRestartWithDeferral -> child exit -> sessionRunnerRespawnManager ->
 * resolveRespawnSessionRuntimeSnapshot -> spawnSession), with only the OS signal/process-identity
 * boundary and the spawn process boundary substituted. The signaled runner "exits" and the
 * child-exit observer reports it exactly as startDaemon's onUnexpectedExit does (forceRestart when
 * the PID holds a restart reservation). startDaemon's wiring is a closure that cannot be imported,
 * so this reproduces it from the same owners.
 */
export function createConnectedServiceRestartReplacementHarness(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  target: ConnectedServiceSwitchTarget;
}>) {
  const { tracked } = input;
  const restartRequestedPids = new Set<number>();
  const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
  const completionWaiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
  const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
  const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: input.sessionId }));
  const onRespawnTerminal = vi.fn();
  const respawnManager = createSessionRunnerRespawnManager({
    enabled: true,
    maxRestarts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterMs: 0,
    isSessionAlreadyRunning: () => false,
    spawnSession,
    // Same resolver as the daemon; no stored account token, so no server read is attempted.
    resolveRespawnOptions: async (respawnInput) => await resolveRespawnSessionRuntimeSnapshot({
      ...respawnInput,
      credentials: null,
      readCredentials: async () => null,
    }),
    onRespawnSuccess: ({ sessionId, previousPid }) => completionWaiters.settle(sessionId, previousPid, { ok: true }),
    onRespawnTerminal,
    random: () => 0,
    logDebug: () => {},
    logWarn: () => {},
  });
  // OS boundary: SIGTERM ends the synthetic runner; the daemon's child-exit observer reports it.
  // Every other PID (for example lock-owner liveness probes) reaches the real process table.
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (pid !== tracked.pid) return realKill(pid, signal);
    const exited = pidToTrackedSession.get(pid);
    if (!exited) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    pidToTrackedSession.delete(pid);
    queueMicrotask(() => respawnManager.handleUnexpectedExit(
      exited,
      { reason: 'signal', code: null, signal: String(signal) },
      { forceRestart: restartRequestedPids.has(exited.pid) },
    ));
    return true;
  });
  const restartSession = vi.fn(async (restartTracked: TrackedSession) => {
    // K5:gated_restart the daemon's connected-service restart composition, reproduced for tests.
    await requestPlannedRunnerRestart({
      sessionId: input.sessionId,
      tracked: restartTracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'manual',
        policy: 'defer_until_turn_boundary',
        target: input.target,
        turnDeferralQueue,
      },
      restartRequestedPids,
      completionWaiters,
      pidToTrackedSession,
      // OS boundary: process-identity probe for the synthetic PID.
      isProcessSafeToSignal: async () => true,
      // The synthetic runner is idle and the daemon is not shutting down.
      canSignal: () => true,
      // K5:gated_restart raw signal is owned by planned runner restart deferral/reservation.
      requestSignal: async (request) => await requestConnectedServiceSessionRestartSignal({
        pid: restartTracked.pid,
        delayMs: 0,
        shouldSignal: request.shouldSignal,
        onSignalFailure: request.onSignalFailure,
        onProcessAlreadyMissing: request.onProcessAlreadyMissing,
      }),
      logDebug: () => {},
    });
  });
  const runnerSignals = () => kill.mock.calls.filter(([pid]) => pid === tracked.pid);
  return { restartSession, spawnSession, onRespawnTerminal, runnerSignals };
}
