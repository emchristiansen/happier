import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus, isPermanentRequestError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { PendingInputRetryEpisode } from '@/api/session/pendingInputRetryEpisode';
import { logger } from '@/ui/logger';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

import type {
  ActiveTurnPendingPumpOptions,
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingForegroundSteerability,
  PendingQueueDeliveryTiming,
  PendingMaterializationReconcileWhenEmpty,
  PendingMaterializationResult,
  SessionProviderInputConsumer,
} from './types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from './pendingQueueDrainPolicy';
import { readPendingLocalId } from '@happier-dev/protocol';
import type { RuntimeActivitySnapshotTail } from '@/api/session/mutations/createSessionMutationOutbox';
import type {
  MaterializeNextPendingOptions,
  PendingMaterializationDiagnosticPhase,
} from '@/api/session/sessionClientPort';

const PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS = 30_000;

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export interface SessionProviderInputConsumerSession {
  waitForProviderInputAdmission: (abortSignal: AbortSignal) => Promise<boolean>;
  materializeNextPendingMessageSafely: (opts?: MaterializeNextPendingOptions) => Promise<PendingMaterializationResult>;
  shouldAttemptPendingMaterialization?: ((opts?: {
    requestedLocalId?: string;
    activeTurnSteerability?: PendingForegroundSteerability;
    pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
  }) => boolean) | undefined;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => unknown | Promise<unknown>) | undefined;
  blockPendingMessageDelivery?: ((params: Readonly<{
    localIds: readonly string[];
    reason: 'unknown';
  }>) => Promise<boolean>) | undefined;
  waitForPendingEligibilityUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  waitForMetadataUpdate?: ((abortSignal?: AbortSignal) => Promise<boolean>) | undefined;
  readRuntimeActivitySnapshotTail?: (() => RuntimeActivitySnapshotTail) | undefined;
  waitForRuntimeActivitySnapshotTailChange?: ((sequence: number, signal?: AbortSignal) => Promise<boolean>) | undefined;
}

export interface SessionProviderInputConsumerOptions<Mode, Message> {
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  onMetadataUpdate?: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty | undefined;
  activeTurnSteerability?: PendingForegroundSteerability | undefined;
  resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
  metadataWaitRetryBackoffMs?: number | undefined;
  pendingDrainMaxPopPerWake?: number | undefined;
}

type WakeWinner =
  | { kind: 'queue'; hasMessages: boolean }
  | { kind: 'meta'; ok: boolean };

function buildMaterializeOptions(
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty,
  activeTurnSteerability: PendingForegroundSteerability | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  expectedRuntimeActivityRevision?: number,
  requestedLocalId?: string,
): MaterializeNextPendingOptions {
  return {
    reconcileWhenEmpty,
    ...(activeTurnSteerability ? { activeTurnSteerability } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
    ...(expectedRuntimeActivityRevision !== undefined ? { expectedRuntimeActivityRevision } : {}),
    ...(requestedLocalId !== undefined ? { requestedLocalId } : {}),
  };
}

function readCommittedIdleRuntimeActivityRevision(
  tail: RuntimeActivitySnapshotTail,
): number | undefined {
  const settlement = tail.settlement;
  if (tail.custody !== null || settlement === null) return undefined;
  if (
    typeof settlement.identity.mutationKey !== 'string'
    || settlement.identity.mutationKey.trim().length === 0
    || !Number.isSafeInteger(settlement.identity.admissionOrder)
    || settlement.identity.admissionOrder <= 0
    || (settlement.result !== 'applied' && settlement.result !== 'unchanged')
    || settlement.desiredValue.state !== 'idle'
    || settlement.desiredValue.activeCount !== 0
    || settlement.committedProjection.state !== 'idle'
    || settlement.committedProjection.activeCount !== 0
    || !Number.isSafeInteger(settlement.committedRevision)
    || settlement.committedRevision < 0
    || settlement.committedProjection.revision !== settlement.committedRevision
  ) return undefined;
  return settlement.committedRevision;
}

/**
 * Every answer the server gives is reported to `observeAnswer` as soon as it arrives, including a
 * first runtime_activity_unknown answer before this helper waits on the Runtime Activity tail
 * (which can last indefinitely) and the exact-revision retry's answer.
 */
async function materializeWithRuntimeActivityTail(
  session: SessionProviderInputConsumerSession,
  options: ReturnType<typeof buildMaterializeOptions>,
  abortSignal: AbortSignal,
  observeAnswer: (result: PendingMaterializationResult) => void,
): Promise<PendingMaterializationResult> {
  const first = await observePendingInputPhase(
    'materialize',
    async (onDiagnosticPhase) => await session.materializeNextPendingMessageSafely({
      ...options,
      onDiagnosticPhase,
    }),
  );
  observeAnswer(first);
  if (
    options.pendingQueueDeliveryTiming !== 'after_runtime_idle'
    || first.type !== 'deferred'
    || first.reason !== 'runtime_activity_unknown'
  ) return first;

  while (!abortSignal.aborted) {
    const tail = session.readRuntimeActivitySnapshotTail?.();
    if (!tail) return first;
    const expectedRuntimeActivityRevision = readCommittedIdleRuntimeActivityRevision(tail);
    if (expectedRuntimeActivityRevision !== undefined) {
      const retried = await observePendingInputPhase(
        'materialize_runtime_tail_retry',
        async (onDiagnosticPhase) => await session.materializeNextPendingMessageSafely({
          ...options,
          expectedRuntimeActivityRevision,
          onDiagnosticPhase,
        }),
      );
      observeAnswer(retried);
      return retried;
    }
    if (tail.custody === null || !session.waitForRuntimeActivitySnapshotTailChange) return first;
    if (!await session.waitForRuntimeActivitySnapshotTailChange(tail.sequence, abortSignal)) return first;
  }
  return first;
}

function readActiveTurnSteerability(opts: {
  activeTurnSteerability?: PendingForegroundSteerability | undefined;
  resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
}): PendingForegroundSteerability | undefined {
  return opts.resolveActiveTurnSteerability?.() ?? opts.activeTurnSteerability;
}

function readPendingQueueDeliveryTiming(opts: {
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
}): PendingQueueDeliveryTiming | undefined {
  return opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming;
}

function buildAttemptOptions(
  activeTurnSteerability: PendingForegroundSteerability | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  requestedLocalId?: string,
): {
  requestedLocalId?: string;
  activeTurnSteerability?: PendingForegroundSteerability;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
} {
  return {
    ...(requestedLocalId !== undefined ? { requestedLocalId } : {}),
    ...(activeTurnSteerability ? { activeTurnSteerability } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
  };
}

function logInputConsumerMaterializationDecision(opts: {
  source: 'waitForNextInput' | 'drainPending';
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnSteerability: PendingForegroundSteerability | undefined;
  result: PendingMaterializationResult;
}): void {
  logger.infoFile('[pendingQueue] input consumer materialization decision', {
    source: opts.source,
    reconcileWhenEmpty: opts.reconcileWhenEmpty,
    activeTurnSteerability: opts.activeTurnSteerability ?? 'unsteerable',
    resultType: opts.result.type,
    ...(opts.result.type === 'materialized'
      ? {
          localId: opts.result.localId,
          seq: opts.result.seq,
        }
      : {}),
    ...(opts.result.type === 'deferred' ? { deferredReason: opts.result.reason } : {}),
  });
}

/** An identical non-materialized answer is logged again at most once per this interval. */
export const INPUT_CONSUMER_NO_INPUT_LOG_REPEAT_MS = 60_000;

type InputConsumerNoInputObservation =
  | Readonly<{ kind: 'answer'; result: PendingMaterializationResult }>
  | Readonly<{ kind: 'request_failed'; errorName: string }>;

/**
 * File-level (info) record of every non-materialized answer one input consumer receives, so a
 * runner that waits for input without starting its provider says why in its default log.
 * Logs IDs, kinds, states and counts only; never message content or error details.
 *
 * A wake storm repeats the same answer many times, so an answer is logged when its
 * (source, kind, reason) differs from the last logged one, and an unchanged answer at most once
 * per INPUT_CONSUMER_NO_INPUT_LOG_REPEAT_MS with the count of answers suppressed since the last
 * line. A materialized answer ends the streak, so the next stall is logged at once.
 */
class InputConsumerNoInputLog {
  private lastKey: string | null = null;
  private lastLoggedAtMs = 0;
  private suppressedSinceLastLog = 0;

  observe(opts: Readonly<{
    source: 'waitForNextInput' | 'drainPending';
    activeTurnSteerability: PendingForegroundSteerability | undefined;
    pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined;
    observation: InputConsumerNoInputObservation;
  }>): void {
    const observation = opts.observation;
    if (observation.kind === 'answer' && observation.result.type === 'materialized') {
      this.lastKey = null;
      this.suppressedSinceLastLog = 0;
      return;
    }
    const resultType = observation.kind === 'answer' ? observation.result.type : 'request_failed';
    const result = observation.kind === 'answer' ? observation.result : null;
    const deferredReason = result?.type === 'deferred' ? result.reason : undefined;
    const errorName = observation.kind === 'request_failed' ? observation.errorName : undefined;
    const key = [opts.source, resultType, deferredReason ?? '', errorName ?? ''].join('|');
    const now = Date.now();
    if (key === this.lastKey && now - this.lastLoggedAtMs < INPUT_CONSUMER_NO_INPUT_LOG_REPEAT_MS) {
      this.suppressedSinceLastLog += 1;
      return;
    }
    const repeatsSinceLastLog = key === this.lastKey ? this.suppressedSinceLastLog : 0;
    this.lastKey = key;
    this.lastLoggedAtMs = now;
    this.suppressedSinceLastLog = 0;
    const retryAfterMs = result?.type === 'deferred' || result?.type === 'retryable_transport'
      ? result.retryAfterMs
      : undefined;
    try {
      logger.infoFile('[pendingQueue] input consumer received no input', {
        source: opts.source,
        resultType,
        ...(deferredReason ? { deferredReason } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(result?.type === 'auth_failure' ? { statusCode: result.statusCode } : {}),
        ...(errorName ? { errorName, errorDetails: 'not shown' } : {}),
        activeTurnSteerability: opts.activeTurnSteerability ?? 'unsteerable',
        ...(opts.pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming } : {}),
        repeatsSinceLastLog,
      });
    } catch {
      // A diagnostic sink failure never changes input delivery.
    }
  }
}

function readErrorName(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0 ? error.name : typeof error;
}

function readPendingDeliveryLocalIdsFromError(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const record = error as {
    localId?: unknown;
    localIds?: unknown;
    userMessageLocalIds?: unknown;
  };
  const rawValues = [
    record.localId,
    ...(Array.isArray(record.localIds) ? record.localIds : []),
    ...(Array.isArray(record.userMessageLocalIds) ? record.userMessageLocalIds : []),
  ];
  const seen = new Set<string>();
  const localIds: string[] = [];
  for (const rawValue of rawValues) {
    const localId = readPendingLocalId(rawValue) ?? '';
    if (!localId || seen.has(localId)) continue;
    seen.add(localId);
    localIds.push(localId);
  }
  return localIds;
}

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  let waitForNextInputTurn: Promise<void> = Promise.resolve();
  const noInputLog = new InputConsumerNoInputLog();
  const materializationRetryEpisode = new PendingInputRetryEpisode('materialization');
  let materializationTurn: Promise<void> = Promise.resolve();
  // Idle and active consumers share the complete pass, including failure accounting.
  // Serializing only the RPC would let a queued pass bypass the preceding backoff.
  const runMaterializationPass = async <Result>(
    signal: AbortSignal,
    pass: () => Promise<Result>,
    readRetry: (result: Result) => Readonly<{ retryAfterMs?: number }> | null,
  ): Promise<Result | undefined> => {
    const previous = materializationTurn;
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    materializationTurn = previous.catch(() => undefined).then(() => current);
    try {
      if (!await waitForSerializedWaitTurn(previous, signal)) return undefined;
      const state = materializationRetryEpisode.beginAttempt();
      if (state.status !== 'retrying' || state.retryAtMs > Date.now()) return undefined;
      const result = await pass();
      const retry = readRetry(result);
      if (retry) materializationRetryEpisode.failed(retry.retryAfterMs, opts.metadataWaitRetryBackoffMs);
      else if (!signal.aborted) materializationRetryEpisode.settled();
      return result;
    } finally {
      release();
    }
  };
  let providerInputAdmissionOpen = true;
  const archiveAdmissionAbort = new AbortController();
  let activeProviderInputDispatches = 0;
  let activePendingMaterializationRequests = 0;
  let providerInputBatchReserved = false;
  const activeProviderInputAdmissionWorkDrainWaiters = new Set<() => void>();

  const notifyProviderInputAdmissionWorkDrained = (): void => {
    if (activeProviderInputDispatches > 0 || activePendingMaterializationRequests > 0) return;
    for (const notify of [...activeProviderInputAdmissionWorkDrainWaiters]) {
      activeProviderInputAdmissionWorkDrainWaiters.delete(notify);
      notify();
    }
  };

  const waitForActiveProviderInputAdmissionWork = async (): Promise<void> => {
    while (activeProviderInputDispatches > 0 || activePendingMaterializationRequests > 0) {
      await new Promise<void>((resolve) => activeProviderInputAdmissionWorkDrainWaiters.add(resolve));
    }
  };

  const runProviderInputDispatch = async <Value>(dispatchOpts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>): Promise<Readonly<{ status: 'dispatched'; value: Value }> | Readonly<{ status: 'cancelled' }>> => {
    if (!providerInputAdmissionOpen || dispatchOpts.abortSignal.aborted) {
      return { status: 'cancelled' };
    }
    if (!await opts.session.waitForProviderInputAdmission(AbortSignal.any([
      dispatchOpts.abortSignal, archiveAdmissionAbort.signal,
    ])) || !providerInputAdmissionOpen || dispatchOpts.abortSignal.aborted) {
      return { status: 'cancelled' };
    }
    // This increment and closeProviderInputAdmissionAndWaitForDispatches's flag write are
    // synchronous, establishing the one event-loop order for replacement versus dispatch.
    providerInputBatchReserved = false;
    activeProviderInputDispatches += 1;
    try {
      return { status: 'dispatched', value: await dispatchOpts.dispatch() };
    } finally {
      activeProviderInputDispatches -= 1;
      notifyProviderInputAdmissionWorkDrained();
    }
  };

  const admissionTrackedSession: SessionProviderInputConsumerSession = {
    waitForProviderInputAdmission: (signal) => opts.session.waitForProviderInputAdmission(AbortSignal.any([
      signal, archiveAdmissionAbort.signal,
    ])),
    materializeNextPendingMessageSafely: async (materializeOpts) => {
      if (!providerInputAdmissionOpen) return { type: 'no_pending' };
      activePendingMaterializationRequests += 1;
      try {
        const result = await opts.session.materializeNextPendingMessageSafely(materializeOpts);
        if (!providerInputAdmissionOpen && result.type === 'materialized') {
          const localId = readPendingLocalId(result.localId);
          if (localId && opts.session.blockPendingMessageDelivery) {
            await opts.session.blockPendingMessageDelivery({
              localIds: [localId],
              reason: 'unknown',
            });
          }
          return { type: 'no_pending' };
        }
        return result;
      } finally {
        activePendingMaterializationRequests -= 1;
        notifyProviderInputAdmissionWorkDrained();
      }
    },
    waitForPendingEligibilityUpdate: (abortSignal) => opts.session.waitForPendingEligibilityUpdate(abortSignal),
    ...(opts.session.waitForMetadataUpdate
      ? { waitForMetadataUpdate: (abortSignal?: AbortSignal) => opts.session.waitForMetadataUpdate!(abortSignal) }
      : {}),
    ...(opts.session.readRuntimeActivitySnapshotTail
      ? { readRuntimeActivitySnapshotTail: () => opts.session.readRuntimeActivitySnapshotTail!() }
      : {}),
    ...(opts.session.waitForRuntimeActivitySnapshotTailChange
      ? {
          waitForRuntimeActivitySnapshotTailChange: (sequence, signal) =>
            opts.session.waitForRuntimeActivitySnapshotTailChange!(sequence, signal),
        }
      : {}),
    ...(opts.session.shouldAttemptPendingMaterialization
      ? {
          shouldAttemptPendingMaterialization: (attemptOpts) =>
            opts.session.shouldAttemptPendingMaterialization!(attemptOpts),
        }
      : {}),
    ...(opts.session.reconcilePendingQueueState
      ? {
          reconcilePendingQueueState: (reconcileOpts) =>
            opts.session.reconcilePendingQueueState!(reconcileOpts),
        }
      : {}),
    ...(opts.session.blockPendingMessageDelivery
      ? {
          blockPendingMessageDelivery: (params) =>
            opts.session.blockPendingMessageDelivery!(params),
        }
      : {}),
  };

  const reconcileReservedProviderInputBatch = async (): Promise<void> => {
    if (
      !providerInputBatchReserved
      || !opts.session.reconcilePendingQueueState
      || !opts.session.shouldAttemptPendingMaterialization
    ) {
      return;
    }

    try {
      await opts.session.reconcilePendingQueueState({ force: false });
    } catch (error) {
      logger.debug('[pendingQueue] reserved provider-input reconciliation deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const activeTurnSteerability = readActiveTurnSteerability(opts);
    const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    if (
      opts.session.shouldAttemptPendingMaterialization(
        buildAttemptOptions(activeTurnSteerability, pendingQueueDeliveryTiming),
      )
    ) {
      providerInputBatchReserved = false;
    }
  };

  const drainPending = async (drainOpts?: DrainPendingOptions): Promise<DrainPendingResult> => {
    const abortSignal = drainOpts?.abortSignal ?? new AbortController().signal;
    const result = await runMaterializationPass(abortSignal, async () => {
      if (opts.messageQueue.size() > 0) {
        return { materialized: 0, stoppedReason: 'drain_disallowed' } as const;
      }
      // Keep the exact localId reservation authoritative before any later claim.
      await reconcileReservedProviderInputBatch();
      if (providerInputBatchReserved) {
        return { materialized: 0, stoppedReason: 'drain_disallowed' } as const;
      }
      const callerShouldContinue = drainOpts?.shouldContinue;
      return await drainPendingMessages({
        ...withDefaultDrainOptions(
          admissionTrackedSession,
          opts.pendingDrainMaxPopPerWake,
          opts.activeTurnSteerability,
          opts.resolveActiveTurnSteerability,
          opts.pendingQueueDeliveryTiming,
          opts.resolvePendingQueueDeliveryTiming,
          {
            ...drainOpts,
            shouldContinue: () => (
              providerInputAdmissionOpen
              && (callerShouldContinue?.() ?? true)
            ),
          },
        ),
        noInputLog,
      });
    }, (passResult) => passResult.stoppedReason === 'retryable_transport'
      ? { retryAfterMs: passResult.retryAfterMs } : null);
    if (result) return result;
    if (abortSignal.aborted) return { materialized: 0, stoppedReason: 'aborted' };
    const state = materializationRetryEpisode.state;
    if (state.status === 'exhausted') return { materialized: 0, stoppedReason: 'retry_exhausted' };
    return {
      materialized: 0, stoppedReason: 'retryable_transport',
      ...(state.status === 'retrying' ? { retryAfterMs: Math.max(1, state.retryAtMs - Date.now()) } : {}),
    };
  };

  return {
    runProviderInputDispatch,
    async closeProviderInputAdmissionAndWaitForDispatches() {
      providerInputAdmissionOpen = false;
      archiveAdmissionAbort.abort();
      await waitForActiveProviderInputAdmissionWork();
    },
    async waitForNextInput(waitOpts) {
      const previousTurn = waitForNextInputTurn;
      let releaseTurn: () => void = () => {};
      const currentTurn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      waitForNextInputTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

      try {
        const canStart = await waitForSerializedWaitTurn(previousTurn, waitOpts.abortSignal);
        if (!canStart || waitOpts.abortSignal.aborted || !providerInputAdmissionOpen) {
          return null;
        }
        // Requesting the next input is the provider loop's acknowledgement that the previously
        // returned batch has left the dequeue-to-invocation gap. This is the completion signal
        // for long-lived provider dispatches that consume multiple batches within one dispatch.
        providerInputBatchReserved = false;
        const batch = await waitForNextInput({
          ...opts,
          onMetadataUpdate: waitOpts.onMetadataUpdate === undefined ? opts.onMetadataUpdate : waitOpts.onMetadataUpdate,
          session: admissionTrackedSession,
          abortSignal: waitOpts.abortSignal,
          isProviderInputAdmissionOpen: () => providerInputAdmissionOpen,
          retryEpisode: materializationRetryEpisode,
          noInputLog,
          // A server deferral is an answer, not a failure: it never spends the retry budget.
          materialize: (pass) => runMaterializationPass(
            waitOpts.abortSignal,
            pass,
            (result) => (result?.kind === 'retry' ? result : null),
          ),
        });
        if (
          batch?.pendingProviderAction !== undefined
          && batch.userMessageLocalIds?.length === 1
        ) {
          // The queue no longer exposes this batch, but the provider has not accepted it yet.
          // Reserve local custody across the dequeue-to-dispatch gap.
          providerInputBatchReserved = true;
        }
        return batch;
      } finally {
        releaseTurn();
      }
    },
    drainPending,
    async pumpPendingWhileActive(pumpOpts) {
      await pumpPendingWhileActive({
        ...pumpOpts,
        waitForPendingEligibilityUpdate: admissionTrackedSession.waitForPendingEligibilityUpdate,
        drainPending,
        retryEpisode: materializationRetryEpisode,
      });
    },
  };
}

async function pumpPendingWhileActive(
  opts: ActiveTurnPendingPumpOptions & Readonly<{
    waitForPendingEligibilityUpdate: SessionProviderInputConsumerSession['waitForPendingEligibilityUpdate'];
    drainPending: (drainOpts?: DrainPendingOptions) => Promise<DrainPendingResult>;
    retryEpisode: PendingInputRetryEpisode;
  }>,
): Promise<void> {
  const retryEpisode = opts.retryEpisode;
  while (!opts.abortSignal.aborted && (opts.shouldContinue?.() ?? true)) {
    const wakeController = new AbortController();
    const onAbort = () => wakeController.abort(opts.abortSignal.reason);
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) wakeController.abort(opts.abortSignal.reason);
    let passDirty = false;
    const armedWake = waitForWakeSignal({
      waitForPendingEligibilityUpdate: opts.waitForPendingEligibilityUpdate,
      controller: wakeController,
      metadataWaitRetryBackoffMs: DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
    }).then((winner) => {
      const updated = winner.kind === 'meta' ? winner.ok : winner.hasMessages;
      if (updated) passDirty = true;
      return updated;
    });
    try {
      const result = await opts.drainPending({ ...opts, abortSignal: opts.abortSignal });
      if (
        opts.abortSignal.aborted || !(opts.shouldContinue?.() ?? true)
        || result.stoppedReason === 'aborted' || result.stoppedReason === 'auth_failure'
      ) return;
      if (passDirty) {
        retryEpisode.freshEvent();
        continue;
      }
      const state = retryEpisode.state;
      if (state.status === 'retrying') {
        const winner = await Promise.race([
          armedWake.then((updated) => ({ kind: 'wake' as const, updated })),
          waitForSessionMetadataRetryBackoff({
            abortSignal: wakeController.signal,
            backoffMs: Math.max(1, state.retryAtMs - Date.now()), minMs: 1,
          }).then(() => ({ kind: 'retry' as const })),
        ]);
        if (winner.kind === 'wake') {
          if (!winner.updated) return;
          retryEpisode.freshEvent();
        }
        continue;
      }
      if (!await armedWake) return;
      retryEpisode.freshEvent();
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
      wakeController.abort('active-turn-pending-pass-complete');
    }
  }
}

async function waitForSerializedWaitTurn(previousTurn: Promise<void>, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;

    const finish = (canStart: boolean) => {
      if (done) return;
      done = true;
      abortSignal.removeEventListener('abort', onAbort);
      resolve(canStart);
    };

    const onAbort = () => finish(false);
    abortSignal.addEventListener('abort', onAbort, { once: true });

    previousTurn.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/**
 * One idle materialization pass's outcome: `retry` is a retryable failure (it spends the retry
 * episode), `recheck` a server deferral that names when to ask again, and null anything else.
 */
type MaterializationPassOutcome =
  | Readonly<{ kind: 'retry'; retryAfterMs?: number }>
  | Readonly<{ kind: 'recheck'; afterMs: number }>
  | null;

/** Upper bound on a server-supplied deferral delay, matching the retry episode's local cap. */
const MAX_DEFERRAL_RECHECK_MS = 300_000;

function readDeferralRecheckAfterMs(result: PendingMaterializationResult): number | undefined {
  if (result.type !== 'deferred') return undefined;
  const retryAfterMs = result.retryAfterMs;
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return undefined;
  return Math.min(MAX_DEFERRAL_RECHECK_MS, Math.ceil(retryAfterMs));
}

async function waitForNextInput<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & {
    abortSignal: AbortSignal;
    isProviderInputAdmissionOpen: () => boolean;
    retryEpisode: PendingInputRetryEpisode;
    noInputLog: InputConsumerNoInputLog;
    materialize: (pass: () => Promise<MaterializationPassOutcome>) => Promise<MaterializationPassOutcome | undefined>;
  },
): Promise<MessageBatch<Mode, Message> | null> {
  const metadataWaitRetryBackoffMs = opts.metadataWaitRetryBackoffMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  const retryEpisode = opts.retryEpisode;

  while (!opts.abortSignal.aborted && opts.isProviderInputAdmissionOpen()) {
    // Arm before the complete pass: an event during any await dirties the pass.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) controller.abort();
    let passDirty = false;
    const wakePromise = waitForWakeSignal({
      messageQueue: opts.messageQueue,
      waitForPendingEligibilityUpdate: opts.session.waitForPendingEligibilityUpdate,
      waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
      onMetadataUpdate: opts.onMetadataUpdate,
      controller,
      metadataWaitRetryBackoffMs,
    }).then((winner) => {
      if (winner.kind === 'queue' ? winner.hasMessages : winner.ok) passDirty = true;
      return winner;
    });
    const applyWake = async (winner: WakeWinner): Promise<boolean> => {
      if (winner.kind === 'queue' && !winner.hasMessages) return false;
      if (winner.kind === 'meta' && !winner.ok) return !opts.abortSignal.aborted;
      retryEpisode.freshEvent();
      if (winner.kind === 'meta') await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
      return true;
    };

    try {
      if (!await opts.session.waitForProviderInputAdmission(opts.abortSignal)
        || opts.abortSignal.aborted || !opts.isProviderInputAdmissionOpen()) return null;
      let batch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
      let recheckAfterMs: number | undefined;
      if (!batch) {
        const outcome = await opts.materialize(() => materializePendingMessage(opts));
        if (outcome?.kind === 'recheck') recheckAfterMs = outcome.afterMs;
        batch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
      }
      if (opts.abortSignal.aborted || !opts.isProviderInputAdmissionOpen()) return null;
      if (batch) {
        await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
        return opts.abortSignal.aborted ? null : batch;
      }
      if (passDirty) {
        if (!await applyWake(await wakePromise)) return null;
        continue;
      }
      const state = retryEpisode.state;
      if (state.status === 'retrying') {
        const retryOrWake = await Promise.race([
          wakePromise.then((winner) => ({ kind: 'wake' as const, winner })),
          waitForSessionMetadataRetryBackoff({
            abortSignal: controller.signal,
            backoffMs: Math.max(1, state.retryAtMs - Date.now()),
            minMs: 1,
          }).then(() => ({ kind: 'retry' as const })),
        ]);
        if (retryOrWake.kind === 'wake' && !await applyWake(retryOrWake.winner)) return null;
        // A timer rejoins the same episode. Only applyWake renews its budget.
        continue;
      }
      if (recheckAfterMs !== undefined) {
        // The server said when this deferral may clear (for example runtime activity); ask
        // again then rather than waiting only for an external wake that may never come.
        const recheckOrWake = await Promise.race([
          wakePromise.then((winner) => ({ kind: 'wake' as const, winner })),
          waitForSessionMetadataRetryBackoff({
            abortSignal: controller.signal,
            backoffMs: recheckAfterMs,
            minMs: 1,
          }).then(() => ({ kind: 'recheck' as const })),
        ]);
        if (recheckOrWake.kind === 'wake' && !await applyWake(recheckOrWake.winner)) return null;
        continue;
      }
      if (!await applyWake(await wakePromise)) return null;
    } finally {
      controller.abort('sessionProviderInputConsumer-pass-complete');
      opts.abortSignal.removeEventListener('abort', onAbort);
    }
  }
  return null;
}

async function collectQueuedBatch<Mode, Message>(
  messageQueue: MessageQueue2<Mode, Message>,
  abortSignal: AbortSignal,
): Promise<MessageBatch<Mode, Message> | null> {
  if (messageQueue.size() <= 0) {
    return null;
  }
  return await messageQueue.waitForMessagesAndGetAsString(abortSignal);
}

async function materializePendingMessage<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & {
    abortSignal: AbortSignal;
    isProviderInputAdmissionOpen: () => boolean;
    noInputLog: InputConsumerNoInputLog;
  },
): Promise<MaterializationPassOutcome> {
  const reconcileWhenEmpty = opts.reconcileWhenEmpty ?? 'skip';
  let activeTurnSteerability = readActiveTurnSteerability(opts);
  let pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
  let result: PendingMaterializationResult;
  try {
    if (!opts.isProviderInputAdmissionOpen()) return null;
    activeTurnSteerability = readActiveTurnSteerability(opts);
    pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    result = await materializeWithRuntimeActivityTail(
      opts.session,
      buildMaterializeOptions(
        reconcileWhenEmpty,
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
      ),
      opts.abortSignal,
      (answer) => opts.noInputLog.observe({
        source: 'waitForNextInput',
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
        observation: { kind: 'answer', result: answer },
      }),
    );
  } catch (error) {
    if (
      opts.abortSignal.aborted
      && error instanceof Error
      && error.name === 'AbortError'
    ) return null;
    if (readAuthenticationStatus(error) !== null) {
      throw new PendingQueueMaterializationAuthError();
    }
    logger.debug('[pendingQueue] input consumer materialization failed (non-fatal)', error);
    opts.noInputLog.observe({
      source: 'waitForNextInput',
      activeTurnSteerability,
      pendingQueueDeliveryTiming,
      observation: { kind: 'request_failed', errorName: readErrorName(error) },
    });
    const localIds = readPendingDeliveryLocalIdsFromError(error);
    if (localIds.length === 1 && opts.session.blockPendingMessageDelivery) {
      await opts.session.blockPendingMessageDelivery({
        localIds,
        reason: 'unknown',
      });
    }
    if (localIds.length === 0 && !isPermanentRequestError(error)) {
      const classified = classifyServerEndpointError(error);
      return classified.retryAfterMs === undefined
        ? { kind: 'retry' }
        : { kind: 'retry', retryAfterMs: classified.retryAfterMs };
    }
    return null;
  }
  logInputConsumerMaterializationDecision({
    source: 'waitForNextInput',
    reconcileWhenEmpty,
    activeTurnSteerability,
    result,
  });
  if (result.type === 'materialized') {
    // The transcript update path owns queue delivery; do not synthesize a provider batch from the pending payload.
    return null;
  }
  if (result.type === 'auth_failure') {
    throw new PendingQueueMaterializationAuthError();
  }
  if (result.type === 'deferred' && result.reason === 'supervisor_auth_failed') {
    throw new PendingQueueMaterializationAuthError();
  }
  const recheckAfterMs = readDeferralRecheckAfterMs(result);
  if (recheckAfterMs !== undefined) return { kind: 'recheck', afterMs: recheckAfterMs };
  if (result.type !== 'retryable_transport') return null;

  // Reconcile through the same authoritative owner; no alternate claim or delivery path.
  if (opts.session.reconcilePendingQueueState) {
    try {
      await opts.session.reconcilePendingQueueState({ force: true });
    } catch (error) {
      if (readAuthenticationStatus(error) !== null) throw new PendingQueueMaterializationAuthError();
      logger.debug('[pendingQueue] retryable transport reconciliation failed (non-fatal)', error);
    }
  }
  return result.retryAfterMs === undefined
    ? { kind: 'retry' }
    : { kind: 'retry', retryAfterMs: result.retryAfterMs };
}

function withDefaultDrainOptions(
  session: SessionProviderInputConsumerSession,
  defaultMaxPopPerWake: number | undefined,
  defaultActiveTurnSteerability: PendingForegroundSteerability | undefined,
  defaultResolveActiveTurnSteerability: (() => PendingForegroundSteerability) | undefined,
  defaultPendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  defaultResolvePendingQueueDeliveryTiming: (() => PendingQueueDeliveryTiming | undefined) | undefined,
  drainOpts: DrainPendingOptions | undefined,
): DrainPendingOptions & { session: SessionProviderInputConsumerSession } {
  const steerabilityOverride = drainOpts?.activeTurnSteerability !== undefined;
  const deliveryTimingOverride = drainOpts?.pendingQueueDeliveryTiming !== undefined;

  return {
    ...(drainOpts ?? {}),
    session,
    maxPopPerWake: drainOpts?.maxPopPerWake ?? defaultMaxPopPerWake,
    activeTurnSteerability: drainOpts?.activeTurnSteerability ?? defaultActiveTurnSteerability,
    resolveActiveTurnSteerability: drainOpts?.resolveActiveTurnSteerability
      ?? (steerabilityOverride ? undefined : defaultResolveActiveTurnSteerability),
    pendingQueueDeliveryTiming: drainOpts?.pendingQueueDeliveryTiming ?? defaultPendingQueueDeliveryTiming,
    resolvePendingQueueDeliveryTiming: drainOpts?.resolvePendingQueueDeliveryTiming
      ?? (deliveryTimingOverride ? undefined : defaultResolvePendingQueueDeliveryTiming),
  };
}

async function drainPendingMessages(
  opts: DrainPendingOptions & { session: SessionProviderInputConsumerSession; noInputLog: InputConsumerNoInputLog },
): Promise<DrainPendingResult> {
  // A materialized row has already left durable server custody and may be replaced locally by a
  // later isolate/control prompt. Keep the claim boundary one row wide regardless of legacy
  // drain-all configuration; the provider loop must consume this invocation before another claim.
  const maxPopPerWake = PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE;
  let materialized = 0;

  for (let i = 0; i < maxPopPerWake; i += 1) {
    try {
      if (opts.abortSignal?.aborted) {
        return { materialized, stoppedReason: 'aborted' };
      }
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { materialized, stoppedReason: 'drain_disallowed' };
      }

      const activeTurnSteerability = readActiveTurnSteerability(opts);
      const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
      const attemptOpts = buildAttemptOptions(activeTurnSteerability, pendingQueueDeliveryTiming, opts.requestedLocalId);
      const canMaterialize = opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true;
      if (!canMaterialize) {
        await opts.session.reconcilePendingQueueState?.({ force: true });
        if (opts.abortSignal?.aborted) {
          return { materialized, stoppedReason: 'aborted' };
        }
        if (!(opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true)) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
      }

      const result = await materializeNextPendingForDrain(
        opts.session,
        opts,
      );
      if (result === 'materialized') {
        materialized += 1;
        continue;
      }
      return typeof result === 'string'
        ? { materialized, stoppedReason: result }
        : { materialized, ...result };
    } catch (error) {
      return { materialized, ...readDrainErrorResult(error, opts) };
    }
  }

  return { materialized, stoppedReason: 'max_pop_per_wake' };
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions & { noInputLog: InputConsumerNoInputLog },
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake' | 'retryable_transport'> | 'materialized' | Readonly<{ stoppedReason: 'retryable_transport'; retryAfterMs?: number }>> {
  let activeTurnSteerability = readActiveTurnSteerability(opts);
  let pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
  try {
    const reconcileWhenEmpty = 'force';
    if (opts.shouldContinue && !opts.shouldContinue()) return 'no_pending';
    activeTurnSteerability = readActiveTurnSteerability(opts);
    pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    const result = await materializeWithRuntimeActivityTail(
      session,
      buildMaterializeOptions(
        reconcileWhenEmpty,
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
        undefined,
        opts.requestedLocalId,
      ),
      opts.abortSignal ?? new AbortController().signal,
      (answer) => opts.noInputLog.observe({
        source: 'drainPending',
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
        observation: { kind: 'answer', result: answer },
      }),
    );
    logInputConsumerMaterializationDecision({
      source: 'drainPending',
      reconcileWhenEmpty,
      activeTurnSteerability,
      result,
    });
    if (result.type === 'materialized') {
      return 'materialized';
    }
    if (result.type === 'deferred') {
      if (result.reason === 'supervisor_auth_failed') {
        logTerminalAuthDrainStop(opts, null);
        return 'auth_failure';
      }
      return 'deferred';
    }
    if (result.type === 'auth_failure') {
      logTerminalAuthDrainStop(opts, result.statusCode);
      return 'auth_failure';
    }
    if (result.type === 'retryable_transport') return {
      stoppedReason: 'retryable_transport',
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
    // Not a transport retry: the session client owns the one reconnect and its wake.
    if (result.type === 'publisher_lost') return 'publisher_lost';
    return 'no_pending';
  } catch (error) {
    opts.noInputLog.observe({
      source: 'drainPending',
      activeTurnSteerability,
      pendingQueueDeliveryTiming,
      observation: { kind: 'request_failed', errorName: readErrorName(error) },
    });
    const result = readDrainErrorResult(error, opts);
    return result.stoppedReason === 'retryable_transport' ? result : result.stoppedReason;
  }
}

function readDrainErrorResult(error: unknown, opts: DrainPendingOptions):
  | Readonly<{ stoppedReason: 'auth_failure' | 'error' }>
  | Readonly<{ stoppedReason: 'retryable_transport'; retryAfterMs?: number }> {
  const terminalAuthStatus = readAuthenticationStatus(error);
  if (terminalAuthStatus !== null) {
    logTerminalAuthDrainStop(opts, terminalAuthStatus);
    return { stoppedReason: 'auth_failure' };
  }
  if (isPermanentRequestError(error)) return { stoppedReason: 'error' };
  const classified = classifyServerEndpointError(error);
  return {
    stoppedReason: 'retryable_transport',
    ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
  };
}

function logTerminalAuthDrainStop(opts: DrainPendingOptions, status: 401 | 403 | null): void {
  logger.debug(`${opts.logPrefix ?? '[INPUT-CONSUMER]'} Stopping pending queue drain after terminal auth failure`, {
    ...(status !== null ? { status } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

async function waitForWakeSignal<Mode, Message>(opts: {
  messageQueue?: MessageQueue2<Mode, Message>;
  waitForPendingEligibilityUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  waitForMetadataUpdate?: ((abortSignal?: AbortSignal) => Promise<boolean>) | undefined;
  onMetadataUpdate?: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined;
  controller: AbortController;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    ?.waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const waitForControls = () => opts.onMetadataUpdate && opts.waitForMetadataUpdate
    ? opts.waitForMetadataUpdate(opts.controller.signal).then(
      (ok) => ({ kind: 'controls' as const, ok }),
      () => ({ kind: 'controls' as const, ok: false }),
    )
    : undefined;
  let controlsWait = waitForControls();
  try {
    while (true) {
      if (opts.controller.signal.aborted) {
        return { kind: 'meta', ok: false };
      }

      const pendingWait = opts.waitForPendingEligibilityUpdate(opts.controller.signal).then(
        (ok) => ({ kind: 'meta' as const, ok }),
        () => ({ kind: 'meta' as const, ok: false }),
      );
      let winner: WakeWinner;
      while (true) {
        if (opts.controller.signal.aborted) return { kind: 'meta', ok: false };
        const next = await Promise.race([
          ...(queueWait ? [queueWait] : []), pendingWait,
          ...(controlsWait ? [controlsWait] : []),
        ]);
        if (next.kind !== 'controls') {
          winner = next;
          break;
        }
        // Keep observing before the callback awaits provider I/O. Metadata controls never
        // settle the Pending wake or authorize another materialization pass.
        controlsWait = next.ok ? waitForControls() : undefined;
        if (next.ok) await callMetadataUpdate(opts.onMetadataUpdate, opts.controller.signal);
      }
      if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
        return winner;
      }

      // Offline/deferred adapters may have no live wake source yet. Retry attaching to that
      // source without polling the queue; real client waits survive transient disconnects.
      const queueIdleOrBackoffWinner = await Promise.race([
        ...(queueWait ? [queueWait] : []),
        waitForSessionMetadataRetryBackoff({
          abortSignal: opts.controller.signal,
          backoffMs: opts.metadataWaitRetryBackoffMs,
        }).then(() => null),
      ]);
      if (queueIdleOrBackoffWinner) {
        return queueIdleOrBackoffWinner;
      }
    }
  } finally {
    // The caller owns the controller and aborts losing waits after each pass.
  }
}

async function callMetadataUpdate(
  onMetadataUpdate: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!onMetadataUpdate || abortSignal.aborted) return;

  let releaseAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    const onAbort = () => resolve('aborted');
    abortSignal.addEventListener('abort', onAbort, { once: true });
    releaseAbort = () => abortSignal.removeEventListener('abort', onAbort);
  });
  const reconciled = Promise.resolve()
    .then(async () => await observePendingInputPhase(
      'metadata_reconcile',
      async () => await onMetadataUpdate(abortSignal),
    ))
    .then(
      () => 'reconciled' as const,
      () => 'failed' as const,
    );

  try {
    await Promise.race([reconciled, aborted]);
  } finally {
    releaseAbort?.();
  }
}

type PendingInputConsumerDiagnosticPhase =
  | 'materialize'
  | 'materialize_runtime_tail_retry'
  | 'metadata_reconcile'
  | PendingMaterializationDiagnosticPhase;

async function observePendingInputPhase<T>(
  initialPhase: PendingInputConsumerDiagnosticPhase,
  operation: (onPhase: (phase: PendingMaterializationDiagnosticPhase) => void) => Promise<T>,
): Promise<T> {
  let phase = initialPhase;
  let startedAt = Date.now();
  let slowDiagnosticEmitted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finishPhase = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (slowDiagnosticEmitted) {
      logger.infoFile('[pendingQueue] input consumer slow phase settled', {
        elapsedMs: Date.now() - startedAt,
        phase,
      });
    }
  };
  const startPhase = () => {
    startedAt = Date.now();
    slowDiagnosticEmitted = false;
    timer = setTimeout(() => {
      slowDiagnosticEmitted = true;
      logger.infoFile('[pendingQueue] input consumer phase remains unsettled', {
        elapsedMs: Date.now() - startedAt,
        phase,
      });
    }, PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS);
    timer.unref?.();
  };
  const onPhase = (nextPhase: PendingMaterializationDiagnosticPhase) => {
    if (nextPhase === phase) return;
    finishPhase();
    phase = nextPhase;
    startPhase();
  };

  startPhase();
  try {
    return await operation(onPhase);
  } finally {
    finishPhase();
  }
}
