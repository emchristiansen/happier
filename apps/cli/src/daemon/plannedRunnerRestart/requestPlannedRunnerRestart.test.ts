import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { ConnectedServiceSwitchDeferralConflictError, createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

describe('requestPlannedRunnerRestart', () => {
  it.each(['idle', 'deferred'] as const)('cleans its reservation when shutdown overtakes an admitted $0 restart', async (admission) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const tracked = trackedSession();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const clearRestartIntentForPid = vi.fn();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    let shutdown = false;
    let resolveAuthority!: (safe: boolean) => void;
    let announceAuthority!: () => void;
    const authority = new Promise<boolean>((resolve) => { resolveAuthority = resolve; });
    const authorityEntered = new Promise<void>((resolve) => { announceAuthority = resolve; });
    let announceRunFinished!: () => void;
    const runFinished = new Promise<void>((resolve) => { announceRunFinished = resolve; });
    if (admission === 'deferred') {
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    }
    const request = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked, reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2, credentialRevision: 'opaque-R1' },
        turnDeferralQueue: {
          requestSwitch: (input) => queue.requestSwitch({
            ...input,
            runSwitch: async () => {
              try { await input.runSwitch(); } finally { announceRunFinished(); }
            },
          }),
        },
      },
      restartRequestedPids, pidToTrackedSession,
      isProcessSafeToSignal: async () => { announceAuthority(); return await authority; },
      requestSignal: async ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
        await requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid, delayMs: 0, shouldSignal, onSignalFailure, onProcessAlreadyMissing,
          isShutdownRequested: () => shutdown,
        }),
      clearRestartIntentForPid, logDebug: () => {},
    });
    // A deferred caller is rejected at cancelAll while its executing callback still owns cleanup.
    const settled = request.then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      if (admission === 'deferred') {
        queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
      }
      await authorityEntered;
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      shutdown = true;
      queue.cancelAll('daemon_shutdown');
      resolveAuthority(true);
      const outcome = await settled;
      if (admission === 'idle') {
        expect(outcome).toEqual({ result: { signaled: false } });
      } else {
        expect(outcome).toEqual({ error: expect.objectContaining({ code: 'daemon_shutdown' }) });
      }
      // The rejected caller alone is not cleanup proof; wait for the canonical cleanup callback.
      await runFinished;
      expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid);
      expect(pidToTrackedSession.get(tracked.pid)).toBe(tracked);
      expect(restartRequestedPids.size).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      shutdown = true;
      resolveAuthority(true);
      queue.cancelAll('daemon_shutdown');
      await settled;
      await runFinished;
      kill.mockRestore();
    }
  });

  it('routes connected-service restarts through deferral before reserving and signalling the runner', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const requestSwitch = vi.fn(async (input: { runSwitch: () => Promise<void> }) => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(false);
      await input.runSwitch();
    });
    const requestSignal = vi.fn(async () => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      return { status: 'requested' as const };
    });

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'automatic',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
        turnDeferralQueue: { requestSwitch },
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(requestSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      source: 'automatic',
      policy: 'defer_until_turn_boundary',
      target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
    }));
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('clears the reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal: async ({ shouldSignal }) => {
        pidToTrackedSession.delete(tracked.pid);
        return shouldSignal() ? { status: 'requested' as const } : { status: 'skipped_stale_owner' as const };
      },
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'stale_owner' });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when pid identity is unsafe', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });
    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: 4242,
      expectedProcessCommandHash: 'hash-1',
    });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when activity starts before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('preserves the exact activity disabled reason when the final signal guard rejects', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({
      signaled: false,
      notSignaledReason: 'activity_in_progress',
      activityDisabledReason: 'approval_pending',
    });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('observes missing processes through the caller hook and keeps the forced-respawn reservation', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const observeProcessMissing = vi.fn();

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal: async () => ({ status: 'process_already_missing' as const }),
      observeProcessMissing,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('preserves connected-service cancellation semantics when a deferred request is superseded', async () => {
    const tracked = trackedSession();
    const restartRequestedPids = new Set<number>();
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));

    const result = await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'automatic',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
        turnDeferralQueue: {
          requestSwitch: async () => {
            throw new ConnectedServiceSwitchDeferralConflictError({
              code: 'switch_cancelled',
              message: 'superseded',
            });
          },
        },
      },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'superseded' });
    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });
});
