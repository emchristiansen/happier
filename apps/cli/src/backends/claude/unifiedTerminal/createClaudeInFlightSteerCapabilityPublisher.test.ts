import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '@/api/types';

import { createClaudeInFlightSteerCapabilityPublisher } from './createClaudeInFlightSteerCapabilityPublisher';

function capture() {
  let state: AgentState = {};
  const session = {
    updateAgentState: (updater: (current: AgentState) => AgentState) => {
      state = updater(state);
    },
  };
  let writes = 0;
  const countingSession = {
    updateAgentState: (updater: (current: AgentState) => AgentState) => {
      writes += 1;
      return session.updateAgentState(updater);
    },
  };
  return { session: countingSession, get state() { return state; }, get writes() { return writes; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createClaudeInFlightSteerCapabilityPublisher (lane P, O-design Seam A)', () => {
  it('publishes unsafe_window with a state timestamp while the canonical turn is active', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(false);
    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(captured.state.capabilities?.inFlightSteerStateAt).toBe(1234);
    publisher.dispose();
  });

  it('passes the user_terminal_draft starvation reason through while the canonical turn is active (lane X)', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(false);
    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('user_terminal_draft');
    expect(captured.state.capabilities?.terminalComposerClearSupported).toBe(true);
    expect(captured.state.capabilities?.terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('publishes terminal composer clear support and clears draft presence when steering becomes available', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
      minPublishIntervalMs: 0,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });
    publisher.publish({ available: true, reason: null });

    expect(captured.state.capabilities?.terminalComposerClearSupported).toBe(true);
    expect(captured.state.capabilities?.terminalComposerDraftPresent).toBe(false);
    publisher.dispose();
  });

  it('publishes Agent SDK steerability without advertising terminal-composer controls', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
      terminalComposerControls: false,
    });

    publisher.publish({ available: true, reason: null });

    expect(captured.state.capabilities?.inFlightSteer).toBe(true);
    expect(captured.state.capabilities?.inFlightSteerSupported).toBe(true);
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(true);
    expect(captured.state.capabilities?.terminalComposerClearSupported).toBeUndefined();
    expect(captured.state.capabilities?.terminalComposerDraftPresent).toBeUndefined();
    publisher.dispose();
  });

  it('emits a final cleared snapshot on dispose after a terminal composer draft', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1234,
      minPublishIntervalMs: 0,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });
    publisher.dispose();

    expect(captured.writes).toBe(2);
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(true);
    expect(captured.state.capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();
    expect(captured.state.capabilities?.terminalComposerDraftPresent).toBe(false);
  });

  it('publishes draft presence from the raw terminal-draft snapshot even when unavailable maps to turn_settling', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => false,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'user_terminal_draft' });

    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('turn_settling');
    expect(captured.state.capabilities?.terminalComposerClearSupported).toBe(true);
    expect(captured.state.capabilities?.terminalComposerDraftPresent).toBe(true);
    publisher.dispose();
  });

  it('maps an unavailable snapshot to turn_settling when the canonical turn is no longer active (N2 probe)', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => false,
      nowMs: () => 1234,
    });

    publisher.publish({ available: false, reason: 'unsafe_window' });

    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('turn_settling');
    publisher.dispose();
  });

  it('clears the reason and de-duplicates identical snapshots', () => {
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      nowMs: () => 1,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: true, reason: null });

    expect(captured.writes).toBe(1);
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(true);
    expect(captured.state.capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();
    publisher.dispose();
  });

  it('rate-limits flapping snapshots with a trailing converging write', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      minPublishIntervalMs: 1000,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });
    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });

    // First write immediate; the flapping follow-ups coalesce into ONE trailing write that
    // converges on the LATEST state.
    expect(captured.writes).toBe(1);
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(captured.writes).toBe(2);
    expect(captured.state.capabilities?.inFlightSteerAvailable).toBe(false);
    expect(captured.state.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    publisher.dispose();
  });

  it('dispose cancels a scheduled trailing write', () => {
    vi.useFakeTimers();
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      isCanonicalTurnActive: () => true,
      minPublishIntervalMs: 1000,
    });

    publisher.publish({ available: true, reason: null });
    publisher.publish({ available: false, reason: 'unsafe_window' });
    publisher.dispose();

    vi.advanceTimersByTime(5000);
    expect(captured.writes).toBe(1);
  });

  it('publishes and clears the exact transient native-custody local id', () => {
    let now = 1_234;
    const captured = capture();
    const publisher = createClaudeInFlightSteerCapabilityPublisher({
      session: captured.session,
      nowMs: () => now,
      minPublishIntervalMs: 0,
    });

    publisher.publishPendingInputInterruptAndRunLocalId('queued-local');
    expect(captured.state.capabilities?.pendingInputInterruptAndRunLocalId).toBe('queued-local');
    expect(captured.state.capabilities?.pendingInputInterruptAndRunStateAt).toBe(1_234);

    now = 1_235;
    publisher.publishPendingInputInterruptAndRunLocalId(null);
    expect(captured.state.capabilities?.pendingInputInterruptAndRunLocalId).toBeNull();
    expect(captured.state.capabilities?.pendingInputInterruptAndRunStateAt).toBe(1_235);
  });
});
