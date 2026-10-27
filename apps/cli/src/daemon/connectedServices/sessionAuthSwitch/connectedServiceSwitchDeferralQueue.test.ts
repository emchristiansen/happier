import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceSwitchDeferralConflictError,
  createConnectedServiceSwitchDeferralQueue,
  type ConnectedServiceSwitchTarget,
} from './connectedServiceSwitchDeferralQueue';

function target(overrides: Partial<ConnectedServiceSwitchTarget> = {}): ConnectedServiceSwitchTarget {
  return {
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'main',
    generation: 5,
    ...overrides,
  };
}

describe('connectedServiceSwitchDeferralQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    { disableDeferral: false, source: 'automatic' as const },
    { disableDeferral: true, source: 'automatic' as const },
    { disableDeferral: false, source: 'manual' as const },
    { disableDeferral: true, source: 'manual' as const },
  ])('keeps shutdown terminal for late $source requests with disableDeferral=$disableDeferral', async ({ disableDeferral, source }) => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral });
    const runSwitch = vi.fn(async () => {});
    queue.cancelAll('daemon_shutdown');
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });

    await expect(queue.requestSwitch({
      sessionId: 'sess_1', policy: 'defer_until_turn_boundary', source, target: target(), runSwitch,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSwitchDeferralConflictError', code: 'daemon_shutdown',
    });
    expect(runSwitch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pending caller at shutdown and refuses a successor after its boundary', async () => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const runSwitch = vi.fn(async () => {});
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1', policy: 'defer_until_turn_boundary', source: 'automatic', target: target(), runSwitch,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'daemon_shutdown' });
    queue.cancelAll('daemon_shutdown');
    await rejected;
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await expect(queue.requestSwitch({
      sessionId: 'sess_1', policy: 'defer_until_idle', source: 'automatic', target: target(), runSwitch,
    })).rejects.toMatchObject({ code: 'daemon_shutdown' });
    expect(runSwitch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defers restart_resume until assistant-message-end when the session is mid-turn', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    expect(runSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferred',
      policy: 'defer_until_turn_boundary',
      awaitingBoundary: true,
      timeoutMs: 60_000,
    }));

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'completed_at_boundary',
    }));
  });

  it('defers automatic restarts while resumed provider work has an active task marker', async () => {
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });

    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target(),
      runSwitch,
    });

    expect(runSwitch).not.toHaveBeenCalled();

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
  });

  it('exposes current turn in-flight state for continuation eligibility', () => {
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    expect(queue.isTurnInFlight('sess_1')).toBe(false);

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    expect(queue.isTurnInFlight('sess_1')).toBe(true);

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    expect(queue.isTurnInFlight('sess_1')).toBe(false);
  });

  it('exposes lifecycle evidence so recovery can distinguish first-prompt retry from mid-turn continuation', () => {
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    expect(queue.getTurnLifecycleState('sess_1')).toEqual({
      inFlight: false,
      lastEvent: null,
      hasProviderActivityThisTurn: false,
      forcedSwitchInterruptedLiveTurn: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    expect(queue.getTurnLifecycleState('sess_1')).toEqual({
      inFlight: true,
      lastEvent: 'prompt_or_steer',
      hasProviderActivityThisTurn: false,
      forcedSwitchInterruptedLiveTurn: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });
    expect(queue.getTurnLifecycleState('sess_1')).toEqual({
      inFlight: true,
      lastEvent: 'task_started',
      hasProviderActivityThisTurn: true,
      forcedSwitchInterruptedLiveTurn: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    expect(queue.getTurnLifecycleState('sess_1')).toEqual({
      inFlight: false,
      lastEvent: 'assistant_message_end',
      hasProviderActivityThisTurn: true,
      forcedSwitchInterruptedLiveTurn: false,
    });
  });

  it('falls back to abort-and-restart exactly once when boundary timeout expires', async () => {
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    vi.advanceTimersByTime(59_999);
    expect(runSwitch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    expect(runSwitch).toHaveBeenCalledTimes(1);
  });

  it('runs a deferred switch only once when two terminal events arrive while runSwitch is in flight', async () => {
    let releaseRunSwitch: () => void = () => {};
    const runSwitch = vi.fn(() => new Promise<void>((resolve) => {
      releaseRunSwitch = resolve;
    }));
    const emitSessionEvent = vi.fn();
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    // Two terminal turn events land back-to-back (e.g. an assistant_message_end immediately followed
    // by a turn_cancelled) within the window where runSwitch is awaited but has not yet settled the
    // pending. The executing flag must be claimed synchronously at entry so the second event is a
    // no-op — otherwise runSwitch (a SIGTERM/restart signal) fires twice and the completion event is
    // double-emitted.
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'turn_cancelled' });

    expect(runSwitch).toHaveBeenCalledTimes(1);

    releaseRunSwitch();
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
    const completedEvents = emitSessionEvent.mock.calls.filter(
      ([, event]) => (event as { type?: string }).type === 'connected_service_account_switch_deferral_completed',
    );
    expect(completedEvents).toHaveLength(1);
  });

  it('rejects the deferred callers with a bounded typed error when runSwitch itself hangs (CL-1)', async () => {
    // A hung runSwitch (stuck materialization / network hang) must not strand the deferred callers
    // forever: the deferral-window timer is cleared at execute-start, so without an execution bound
    // the pending leaks until session teardown.
    const runSwitch = vi.fn(() => new Promise<void>(() => {}));
    const emitSessionEvent = vi.fn();
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });
    const outcome = expect(pending).rejects.toMatchObject({
      name: 'ConnectedServiceSwitchDeferralConflictError',
      code: 'switch_execution_timeout',
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    expect(runSwitch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await outcome;
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'aborted_after_timeout',
    }));

    // The pending entry is settled and cleared: a fresh idle-session request runs immediately
    // instead of piggybacking onto the leaked hung pending.
    const followUp = vi.fn(async () => {});
    await queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch: followUp,
    });
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('closes the in-flight turn at a forced boundary when the deferral timeout fires (no silent mid-stream kill)', async () => {
    // Lane F deferral-timeout escape hatch: when the boundary never arrives within the timeout the
    // switch is forced, but the turn must be closed cleanly first so downstream (and the managed-
    // server release in-flight-turn guard) sees a quiesced turn rather than an indefinitely stuck
    // in-flight flag that would either wedge the forced switch or leak the old server.
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    expect(queue.isTurnInFlight('sess_1')).toBe(true);

    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    vi.advanceTimersByTime(60_000);
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
    // The forced switch closed the turn at a (forced) boundary instead of leaving it mid-stream.
    expect(queue.isTurnInFlight('sess_1')).toBe(false);
    expect(queue.getTurnLifecycleState('sess_1').lastEvent).toBe('turn_cancelled');
    // The forced boundary genuinely interrupted a live turn — the continuation replay plan needs
    // this fact, because at plan-resolution time the turn is already closed (inFlight false).
    expect(queue.getTurnLifecycleState('sess_1').forcedSwitchInterruptedLiveTurn).toBe(true);

    // The interruption fact is scoped to the interrupted turn: the next prompt starts a new turn
    // and clears it, so a later idle-session switch cannot read it as stale interruption evidence.
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    expect(queue.getTurnLifecycleState('sess_1').forcedSwitchInterruptedLiveTurn).toBe(false);
  });

  it('does not record a forced-boundary interruption when the deferral timeout fires while the session is idle', async () => {
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });

    // Mid-turn request defers; the turn then completes normally BEFORE the timeout would fire, so
    // the switch runs at a clean boundary — no live turn was interrupted.
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
    expect(queue.getTurnLifecycleState('sess_1').forcedSwitchInterruptedLiveTurn).toBe(false);
  });

  it('bypasses deferral when HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL is enabled', async () => {
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: true,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    await queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    expect(runSwitch).toHaveBeenCalledTimes(1);
  });

  it('treats turn cancellation as a real boundary completion instead of a cancelled switch', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target(),
      runSwitch,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'turn_cancelled' });
    await pending;

    expect(runSwitch).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'completed_at_boundary',
    }));
  });

  it('coalesces same-target requests, cancels superseded requests, and rejects older generations', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

    const first = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target({ generation: 5 }),
      runSwitch,
    });
    const coalesced = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target({ generation: 5 }),
      runSwitch,
    });
    const replacedByNewerGeneration = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target({ profileId: 'backup', generation: 6 }),
      runSwitch,
    });

    await expect(queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target({ profileId: 'older', generation: 4 }),
      runSwitch,
    })).rejects.toMatchObject({ code: 'group_generation_conflict' });

    const replacedByManual = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'manual',
      target: target({ profileId: 'manual', generation: 6 }),
      runSwitch,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await expect(first).rejects.toMatchObject({ code: 'switch_cancelled' });
    await expect(coalesced).rejects.toMatchObject({ code: 'switch_cancelled' });
    await expect(replacedByNewerGeneration).rejects.toMatchObject({ code: 'switch_cancelled' });
    await expect(replacedByManual).resolves.toBeUndefined();

    expect(runSwitch).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_superseded',
    }));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'switch_cancelled',
    }));
  });

  it('defers quota pre-turn switchUntilIdle and runs before the next forwardable turn when idle is reached', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_idle',
      source: 'automatic',
      target: target(),
      runSwitch,
    });

    expect(runSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferred',
      policy: 'defer_until_idle',
      awaitingBoundary: false,
    }));

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    expect(runSwitch).not.toHaveBeenCalled();

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await pending;
    expect(runSwitch).toHaveBeenCalledTimes(1);
  });

  it('settles a pending switch on session_restarting without emitting a cancelled/terminated event', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target(),
      runSwitch,
    });

    // A connected-service forced restart applies the deferred switch via respawn: the pending settles
    // (no leak) and NO deferral_completed/cancelled event is emitted — emitting one would misleadingly
    // read as "Account switch cancelled" exactly while the session is restarting (the exit-143 RCA).
    queue.cancelSession('sess_1', 'session_restarting');
    await expect(pending).resolves.toBeUndefined();
    expect(runSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ type: 'connected_service_account_switch_deferral_completed' }),
    );
  });

  it('cancels pending switches on session termination and daemon shutdown with completion reasons', async () => {
    const emitSessionEvent = vi.fn();
    const runSwitch = vi.fn(async () => {});
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent,
    });

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const pending = queue.requestSwitch({
      sessionId: 'sess_1',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target(),
      runSwitch,
    });

    queue.cancelSession('sess_1', 'session_terminated');
    await expect(pending).rejects.toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);
    expect(runSwitch).not.toHaveBeenCalled();

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_2', event: 'prompt_or_steer' });
    const pendingSecond = queue.requestSwitch({
      sessionId: 'sess_2',
      policy: 'defer_until_turn_boundary',
      source: 'automatic',
      target: target({ serviceId: 'anthropic' }),
      runSwitch,
    });
    queue.cancelAll('daemon_shutdown');
    await expect(pendingSecond).rejects.toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'session_terminated',
    }));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_2', expect.objectContaining({
      type: 'connected_service_account_switch_deferral_completed',
      reason: 'daemon_shutdown',
    }));
  });
  it.each([
    ['csr_z_first', 'csr_a_current'],
    ['csr_same', ' csr_same '],
    [undefined, 'csr_required'],
    ['csr_required', undefined],
  ])('replaces a distinct opaque automatic target without revision ordering (%s -> %s)', async (firstRevision, currentRevision) => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const first = vi.fn(async () => {});
    const current = vi.fn(async () => {});
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const request = (credentialRevision: string | undefined, runSwitch: () => Promise<void>) => queue.requestSwitch({
      sessionId: 's1', policy: 'defer_until_turn_boundary', source: 'automatic',
      target: { ...target(), ...(credentialRevision === undefined ? {} : { credentialRevision }) }, runSwitch,
    });
    const old = request(firstRevision, first).then(() => null, (error: unknown) => error);
    const replacement = request(currentRevision, current);
    try {
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      await replacement;
      expect(current).toHaveBeenCalledOnce();
      expect(first).not.toHaveBeenCalled();
      expect(await old).toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled([old, replacement]); }
  });

  it.each([undefined, 'csr_exact'])('joins exact opaque revision duplicates (%s)', async (credentialRevision) => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const first = vi.fn(async () => {});
    const duplicate = vi.fn(async () => {});
    const sameTarget = { ...target(), ...(credentialRevision === undefined ? {} : { credentialRevision }) };
    const pending = [first, duplicate].map((runSwitch) => queue.requestSwitch({
      sessionId: 's1', policy: 'defer_until_turn_boundary', source: 'automatic', target: sameTarget, runSwitch,
    }));
    try {
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      await Promise.all(pending);
      expect(first).toHaveBeenCalledOnce();
      expect(duplicate).not.toHaveBeenCalled();
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled(pending); }
  });

  it.each(['older', 'newer', 'manual', 'stop'] as const)('preserves generation, manual and cancellation gates with opaque revisions: %s', async (mode) => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const first = vi.fn(async () => {});
    const incoming = vi.fn(async () => {});
    const firstTarget = mode === 'manual'
      ? { serviceId: '__multi_service_switch__', profileId: '', groupId: '', generation: 0 }
      : { ...target(), credentialRevision: 'csr_z_first' };
    const old = queue.requestSwitch({ sessionId: 's1', source: mode === 'manual' ? 'manual' : 'automatic',
      policy: 'defer_until_turn_boundary', target: firstTarget, runSwitch: first }).then(() => null, (error: unknown) => error);
    const next = queue.requestSwitch({ sessionId: 's1', source: 'automatic', policy: 'defer_until_turn_boundary',
      target: { ...target({ generation: mode === 'older' ? 4 : mode === 'newer' ? 6 : 5 }), credentialRevision: 'csr_a_current' },
      runSwitch: incoming }).then(() => null, (error: unknown) => error);
    try {
      if (mode === 'stop') queue.cancelSession('s1', 'session_terminated');
      queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
      const outcomes = await Promise.all([old, next]);
      expect(first).toHaveBeenCalledTimes(mode === 'older' || mode === 'manual' ? 1 : 0);
      expect(incoming).toHaveBeenCalledTimes(mode === 'newer' ? 1 : 0);
      if (mode === 'newer' || mode === 'stop') expect(outcomes[0]).toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);
      if (mode === 'older' || mode === 'stop') expect(outcomes[1]).toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);
    } finally { queue.cancelAll('daemon_shutdown'); await Promise.allSettled([old, next]); }
  });

});
