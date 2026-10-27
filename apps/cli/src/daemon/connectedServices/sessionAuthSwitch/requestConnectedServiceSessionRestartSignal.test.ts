import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConnectedServiceSessionRestartAmplificationGuard,
  isConnectedServiceRestartSignalStaleProcessError,
  requestConnectedServiceSessionRestartSignal,
  shouldEmitConnectedServiceRestartRequestedSessionEvent,
} from './requestConnectedServiceSessionRestartSignal';

describe('requestConnectedServiceSessionRestartSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses shutdown before consulting asynchronous signal authority', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const shouldSignal = vi.fn(async () => true);
    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123, delayMs: 0, shouldSignal, isShutdownRequested: () => true, onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'skipped_stale_owner' });
    expect(shouldSignal).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('rechecks shutdown after in-flight signal authority returns true', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let shutdown = false;
    let resolveAuthority!: (current: boolean) => void;
    const authority = new Promise<boolean>((resolve) => { resolveAuthority = resolve; });
    const request = requestConnectedServiceSessionRestartSignal({
      pid: 123, delayMs: 0, shouldSignal: () => authority,
      isShutdownRequested: () => shutdown, onSignalFailure: () => {},
    });
    shutdown = true;
    resolveAuthority(true);
    await expect(request).resolves.toEqual({ status: 'skipped_stale_owner' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('closes the microtask gap after a synchronously true authority result', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let shutdown = false;
    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123, delayMs: 0,
      shouldSignal: () => {
        queueMicrotask(() => { shutdown = true; });
        return true;
      },
      isShutdownRequested: () => shutdown, onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'skipped_stale_owner' });
    expect(shutdown).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses a delayed signal whose daemon shuts down before its timer', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let shutdown = false;
    const request = requestConnectedServiceSessionRestartSignal({
      pid: 123, delayMs: 50, shouldSignal: async () => true,
      isShutdownRequested: () => shutdown, onSignalFailure: () => {},
    });
    shutdown = true;
    await vi.advanceTimersByTimeAsync(50);
    await expect(request).resolves.toEqual({ status: 'skipped_stale_owner' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('preserves an active daemon signal when the lifetime predicate stays false', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123, delayMs: 0, shouldSignal: async () => true,
      isShutdownRequested: () => false, onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'requested' });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  it('assigns one transcript author to switch-FSM and direct-signal restart requests', () => {
    expect(shouldEmitConnectedServiceRestartRequestedSessionEvent({ owner: 'switch_fsm', signaled: true })).toBe(false);
    expect(shouldEmitConnectedServiceRestartRequestedSessionEvent({ owner: 'restart_signal', signaled: true })).toBe(true);
    expect(shouldEmitConnectedServiceRestartRequestedSessionEvent({ owner: 'restart_signal', signaled: false })).toBe(false);
  });

  it('waits for a delayed restart signal before resolving', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    let settled = false;
    const promise = requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 50,
      onSignalFailure: () => {},
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(settled).toBe(true);
  });

  it('rejects when a non-stale restart signal fails', async () => {
    const error = new Error('operation not permitted');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const onSignalFailure = vi.fn();

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure,
    })).rejects.toThrow(error);

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(onSignalFailure).toHaveBeenCalledWith(error);
  });

  it('treats an already-missing process as a completed restart request', async () => {
    const error = new Error('no such process');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const onSignalFailure = vi.fn();
    const onProcessAlreadyMissing = vi.fn();
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure,
      onProcessAlreadyMissing,
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic: {
        trigger: 'automatic_group_switch',
        sessionId: 'session-1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        profileId: 'codex1',
        groupId: 'happier',
        generation: 70,
        reason: 'usage_limit',
      },
    })).resolves.toEqual({ status: 'process_already_missing' });

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(onSignalFailure).not.toHaveBeenCalled();
    expect(onProcessAlreadyMissing).toHaveBeenCalledOnce();
    expect(records).toEqual([
      expect.objectContaining({
        status: 'requested',
        sessionId: 'session-1',
        pid: 123,
      }),
      expect.objectContaining({
        status: 'process_already_missing',
        sessionId: 'session-1',
        pid: 123,
      }),
    ]);
  });

  it('classifies missing process signal failures without treating every signal error as stale', () => {
    const staleByCode = new Error('kill ESRCH');
    Object.assign(staleByCode, { code: 'ESRCH' });

    expect(isConnectedServiceRestartSignalStaleProcessError(staleByCode)).toBe(true);
    expect(isConnectedServiceRestartSignalStaleProcessError(new Error('no such process'))).toBe(true);
    expect(isConnectedServiceRestartSignalStaleProcessError(new Error('operation not permitted'))).toBe(false);
  });

  it('records a uniform daemon restart diagnostic before signaling', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      processGroupPid: 456,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic: {
        trigger: 'manual_switch',
        sessionId: 'session-1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: null,
        generation: null,
        reason: 'manual',
      },
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenCalledWith(-456, 'SIGTERM');
    expect(records).toEqual([{
      type: 'connected_service_daemon_restart',
      trigger: 'manual_switch',
      status: 'requested',
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: null,
      generation: null,
      reason: 'manual',
      pid: 123,
      processGroupPid: 456,
      delayMs: 0,
      atMs: 10_000,
    }]);
  });

  it('builds a visible restart-request transcript event from connected-service restart diagnostics', async () => {
    const module = await import('./requestConnectedServiceSessionRestartSignal');
    const buildEvent = (module as Record<string, unknown>).buildConnectedServiceRestartRequestedSessionEvent;

    expect(typeof buildEvent).toBe('function');
    expect((buildEvent as (input: unknown) => unknown)({
      trigger: 'refresh_triggered_restart',
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'team',
      generation: 7,
      reason: 'refresh_triggered_restart',
    })).toEqual({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      reason: 'refresh_triggered_restart',
      attemptedContinuityMode: 'restart',
      outcome: 'observed',
      outcomeAction: 'none',
      errorCode: null,
      groupGeneration: 7,
      partialState: null,
      diagnostic: expect.objectContaining({
        code: 'connected_service_restart_requested',
        failurePhase: 'restart',
        source: 'transcript_switch_attempt',
        serviceId: 'claude-subscription',
        agentId: 'claude',
        profileId: 'work',
        groupId: 'team',
        retryable: true,
        diagnostics: expect.objectContaining({
          trigger: 'refresh_triggered_restart',
          reason: 'refresh_triggered_restart',
        }),
      }),
    });
  });

  it('suppresses duplicate auth-recovery restart requests for the same session service generation until respawn completes', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const records: unknown[] = [];
    const restartAmplificationGuard = createConnectedServiceSessionRestartAmplificationGuard();
    const restartDiagnostic = {
      trigger: 'runtime_auth_recovery_restart' as const,
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'team',
      generation: 7,
      reason: 'auth_failed',
    };

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic,
      restartAmplificationGuard,
    })).resolves.toEqual({ status: 'requested' });

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 456,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_001,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic,
      restartAmplificationGuard,
    })).resolves.toEqual({ status: 'skipped_duplicate_restart' });

    restartAmplificationGuard.completePid(123, { status: 'success' });

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 456,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_002,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic,
      restartAmplificationGuard,
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenCalledTimes(2);
    expect(records).toEqual([
      expect.objectContaining({ status: 'requested', pid: 123 }),
      expect.objectContaining({ status: 'duplicate_restart_suppressed', pid: 456 }),
      expect.objectContaining({ status: 'requested', pid: 456 }),
    ]);
  });

  it('treats not_authenticated as terminal for the same auth-recovery generation', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const records: unknown[] = [];
    const restartAmplificationGuard = createConnectedServiceSessionRestartAmplificationGuard();
    const restartDiagnostic = {
      trigger: 'runtime_auth_recovery_restart' as const,
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'team',
      generation: 7,
      reason: 'auth_failed',
    };

    await requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic,
      restartAmplificationGuard,
    });
    restartAmplificationGuard.completePid(123, { status: 'terminal', reason: 'not_authenticated' });

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 456,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_001,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic,
      restartAmplificationGuard,
    })).resolves.toEqual({ status: 'skipped_terminal_restart' });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({ status: 'requested', pid: 123 }),
      expect.objectContaining({ status: 'terminal_restart_suppressed', pid: 456 }),
    ]);
  });

  it('records a signal-failed daemon restart diagnostic when non-stale signaling fails', async () => {
    const error = new Error('operation not permitted');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic: {
        trigger: 'runtime_auth_recovery_restart',
        sessionId: 'session-1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        generation: 2,
        reason: 'auth_expired',
      },
    })).rejects.toThrow(error);

    expect(records).toEqual([
      expect.objectContaining({
        type: 'connected_service_daemon_restart',
        trigger: 'runtime_auth_recovery_restart',
        status: 'requested',
        sessionId: 'session-1',
        pid: 123,
      }),
      expect.objectContaining({
        type: 'connected_service_daemon_restart',
        trigger: 'runtime_auth_recovery_restart',
        status: 'signal_failed',
        sessionId: 'session-1',
        pid: 123,
      }),
    ]);
  });

  it('prefers signaling the daemon-spawned process group before falling back to the child pid', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      processGroupPid: 456,
      delayMs: 0,
      onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-456, 'SIGTERM');
  });

  it('falls back to the child pid when process-group signaling is unavailable', async () => {
    const error = new Error('group missing');
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -456) throw error;
      return true;
    });
    const onSignalFailure = vi.fn();

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      processGroupPid: 456,
      delayMs: 0,
      onSignalFailure,
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenNthCalledWith(1, -456, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGTERM');
    expect(onSignalFailure).not.toHaveBeenCalled();
  });

  it('skips a delayed signal when the session no longer owns the pid', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const shouldSignal = vi.fn(() => false);

    const promise = requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 50,
      shouldSignal,
      onSignalFailure: () => {},
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual({ status: 'skipped_stale_owner' });

    expect(shouldSignal).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });
});
