import type { AgentState, InFlightSteerUnavailableReason } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 1000;

export type ClaudeInFlightSteerAvailabilitySnapshot = Readonly<{
  available: boolean;
  /** `user_terminal_draft` = lane-X starvation escalation (a composer draft blocks steering). */
  reason: 'unsafe_window' | 'user_terminal_draft' | null;
}>;

export type ClaudeInFlightSteerCapabilityPublisher = Readonly<{
  publish: (snapshot: ClaudeInFlightSteerAvailabilitySnapshot) => void;
  publishPendingInputInterruptAndRunLocalId: (localId: string | null) => void;
  dispose: () => void;
}>;

type ClaudeInFlightSteerCapabilitySession = Readonly<{
  updateAgentState: (updater: (current: AgentState) => AgentState) => Promise<void> | void;
}>;

export function publishClaudeInFlightSteerBackendUnsupported(opts: Readonly<{
  session: ClaudeInFlightSteerCapabilitySession;
  nowMs?: (() => number) | undefined;
}>): void {
  const stateAt = (opts.nowMs ?? Date.now)();
  updateAgentStateBestEffort(
    opts.session,
    (currentState) => ({
      ...currentState,
      capabilities: {
        ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
        inFlightSteer: false,
        inFlightSteerSupported: false,
        inFlightSteerAvailable: false,
        inFlightSteerUnavailableReason: 'backend_unsupported',
        inFlightSteerStateAt: stateAt,
      },
    }),
    '[claude]',
    'in_flight_steer_backend_unsupported',
  );
}

/**
 * Publishes a steer-capable Claude runtime's live availability snapshot (lane P, O-design Seam A)
 * into `agentState.capabilities` so the UI can select the exact in-flight delivery action. Consumes
 * the evaluator's de-duplicated tee and:
 *
 * - maps unavailable → `turn_settling` when the CANONICAL turn (N2 probe) is no longer active —
 *   one turn-truth owner, no second turn-state source;
 * - de-duplicates identical states and rate-limits flapping screen vetoes with a trailing
 *   converging write (`minPublishIntervalMs`, default 1s);
 * - stamps `inFlightSteerStateAt` so the UI can ignore stale snapshots.
 */
export function createClaudeInFlightSteerCapabilityPublisher(opts: Readonly<{
  session: ClaudeInFlightSteerCapabilitySession;
  /** N2 canonical-turn probe; absent counts as active (fail-closed toward unsafe_window). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
  minPublishIntervalMs?: number | undefined;
  /** Agent SDK shares steerability publication but has no terminal composer to clear. */
  terminalComposerControls?: boolean | undefined;
}>): ClaudeInFlightSteerCapabilityPublisher {
  const nowMs = opts.nowMs ?? Date.now;
  const minPublishIntervalMs = Math.max(0, opts.minPublishIntervalMs ?? DEFAULT_MIN_PUBLISH_INTERVAL_MS);

  let disposed = false;
  let lastPublishedKey: string | null = null;
  let lastPublishAtMs: number | null = null;
  let pendingSnapshot: ClaudeInFlightSteerAvailabilitySnapshot | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPendingInputInterruptAndRunLocalId: string | null | undefined;

  function resolveReason(snapshot: ClaudeInFlightSteerAvailabilitySnapshot): InFlightSteerUnavailableReason | null {
    if (snapshot.available) return null;
    const canonicalActive = opts.isCanonicalTurnActive?.() ?? true;
    return canonicalActive ? (snapshot.reason ?? 'unsafe_window') : 'turn_settling';
  }

  function write(snapshot: ClaudeInFlightSteerAvailabilitySnapshot): void {
    const reason = resolveReason(snapshot);
    const terminalComposerControls = opts.terminalComposerControls !== false;
    const terminalComposerDraftPresent = terminalComposerControls
      && !snapshot.available
      && snapshot.reason === 'user_terminal_draft';
    const key = `${snapshot.available}:${reason ?? ''}:${terminalComposerDraftPresent}`;
    if (key === lastPublishedKey) return;
    lastPublishedKey = key;
    lastPublishAtMs = nowMs();
    const stateAt = lastPublishAtMs;
    updateAgentStateBestEffort(
      opts.session,
      (currentState) => ({
        ...currentState,
        capabilities: {
          ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
          inFlightSteer: true,
          inFlightSteerSupported: true,
          inFlightSteerAvailable: snapshot.available,
          inFlightSteerUnavailableReason: reason,
          inFlightSteerStateAt: stateAt,
          ...(terminalComposerControls
            ? {
                terminalComposerClearSupported: true,
                terminalComposerDraftPresent,
              }
            : {}),
        },
      }),
      '[unified]',
      'in_flight_steer_capabilities',
    );
  }

  function flushPending(): void {
    trailingTimer = null;
    if (disposed || pendingSnapshot === null) return;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    write(snapshot);
  }

  return {
    publish(snapshot) {
      if (disposed) return;
      const withinInterval = lastPublishAtMs !== null && nowMs() - lastPublishAtMs < minPublishIntervalMs;
      if (!withinInterval) {
        write(snapshot);
        return;
      }
      // Flap guard: coalesce rapid changes into one trailing write that converges on the latest.
      pendingSnapshot = snapshot;
      if (trailingTimer === null) {
        const delayMs = Math.max(0, minPublishIntervalMs - (nowMs() - (lastPublishAtMs ?? 0)));
        trailingTimer = setTimeout(flushPending, delayMs);
        trailingTimer.unref?.();
      }
    },
    publishPendingInputInterruptAndRunLocalId(localId) {
      if (disposed || lastPendingInputInterruptAndRunLocalId === localId) return;
      lastPendingInputInterruptAndRunLocalId = localId;
      const stateAt = nowMs();
      updateAgentStateBestEffort(
        opts.session,
        (currentState) => ({
          ...currentState,
          capabilities: {
            ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
            pendingInputInterruptAndRunLocalId: localId,
            pendingInputInterruptAndRunStateAt: stateAt,
          },
        }),
        '[unified]',
        'pending_input_interrupt_and_run_capability',
      );
    },
    dispose() {
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      pendingSnapshot = null;
      if (lastPendingInputInterruptAndRunLocalId !== undefined && lastPendingInputInterruptAndRunLocalId !== null) {
        const stateAt = nowMs();
        updateAgentStateBestEffort(
          opts.session,
          (currentState) => ({
            ...currentState,
            capabilities: {
              ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
              pendingInputInterruptAndRunLocalId: null,
              pendingInputInterruptAndRunStateAt: stateAt,
            },
          }),
          '[unified]',
          'pending_input_interrupt_and_run_capability',
        );
      }
      lastPendingInputInterruptAndRunLocalId = null;
      if (lastPublishedKey !== null) {
        write({ available: true, reason: null });
      }
      disposed = true;
    },
  };
}
