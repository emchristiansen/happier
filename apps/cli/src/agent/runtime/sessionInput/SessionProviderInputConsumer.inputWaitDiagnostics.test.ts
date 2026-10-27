import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { RuntimeActivitySnapshotTail } from '@/api/session/mutations/createSessionMutationOutbox';
import { logger } from '@/ui/logger';

import { createSessionProviderInputConsumer } from './SessionProviderInputConsumer';

type TestMode = { id: string };

const NO_INPUT_LOG = '[pendingQueue] input consumer received no input';

function waitForAbortOnly(signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    signal?.addEventListener('abort', () => resolve(false), { once: true });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

// Runtime Activity custody not yet settled: the consumer waits on the tail before its exact retry.
const unsettledTail: RuntimeActivitySnapshotTail = {
  sequence: 7,
  custody: {
    identity: { mutationKey: 'activity-pending-8', admissionOrder: 8 },
    value: { state: 'idle' as const, activeCount: 0 },
  },
  settlement: {
    identity: { mutationKey: 'activity-applied-6', admissionOrder: 6 },
    desiredValue: { state: 'active' as const, activeCount: 1 },
    result: 'applied' as const,
    committedProjection: { state: 'active' as const, activeCount: 1, observedAt: 90, revision: 40 },
    committedRevision: 40,
  },
} as RuntimeActivitySnapshotTail;

const settledIdleTail: RuntimeActivitySnapshotTail = {
  sequence: 8,
  custody: null,
  settlement: {
    identity: { mutationKey: 'activity-pending-8', admissionOrder: 8 },
    desiredValue: { state: 'idle', activeCount: 0 },
    result: 'applied',
    committedProjection: { state: 'idle', activeCount: 0, observedAt: 100, revision: 41 },
    committedRevision: 41,
  },
} as RuntimeActivitySnapshotTail;

function noInputLogCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter((call) => call[0] === NO_INPUT_LOG);
}

describe('SessionProviderInputConsumer input-wait diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs a non-materialized answer at file level with its kind, reason and retry delay', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const controller = new AbortController();
    const materializeNextPendingMessageSafely = vi.fn(async (): Promise<MaterializeNextPendingResult> => ({
      type: 'deferred',
      reason: 'waiting_for_predecessor',
    }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
    });

    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(noInputLogCalls(infoFile)).toHaveLength(1));
    expect(noInputLogCalls(infoFile)[0]?.[1]).toMatchObject({
      source: 'waitForNextInput',
      resultType: 'deferred',
      deferredReason: 'waiting_for_predecessor',
    });

    controller.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('logs retryable transport answers with the server retry delay', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely: async () => ({ type: 'retryable_transport', retryAfterMs: 750 }),
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
    });

    await expect(consumer.drainPending({ reason: 'diagnostic-transport' })).resolves.toMatchObject({
      stoppedReason: 'retryable_transport',
    });
    expect(noInputLogCalls(infoFile)).toEqual([[
      NO_INPUT_LOG,
      expect.objectContaining({
        source: 'drainPending',
        resultType: 'retryable_transport',
        retryAfterMs: 750,
      }),
    ]]);
  });

  it('dedupes repeated identical answers, repeats them periodically and logs a change at once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    let answer: MaterializeNextPendingResult = { type: 'deferred', reason: 'waiting_for_predecessor' };
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely: async () => answer,
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
    });

    // A wake storm: the same answer many times in quick succession is logged once.
    for (let i = 0; i < 5; i += 1) {
      await consumer.drainPending({ reason: 'wake-storm' });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(noInputLogCalls(infoFile)).toHaveLength(1);

    // The same answer after the repeat interval is logged again with the suppressed count.
    await vi.advanceTimersByTimeAsync(60_000);
    await consumer.drainPending({ reason: 'periodic-repeat' });
    expect(noInputLogCalls(infoFile)).toHaveLength(2);
    expect(noInputLogCalls(infoFile)[1]?.[1]).toMatchObject({
      resultType: 'deferred',
      deferredReason: 'waiting_for_predecessor',
      repeatsSinceLastLog: 4,
    });

    // A changed answer is logged immediately.
    answer = { type: 'deferred', reason: 'waiting_for_foreground_turn' };
    await consumer.drainPending({ reason: 'changed-answer' });
    expect(noInputLogCalls(infoFile)).toHaveLength(3);
    expect(noInputLogCalls(infoFile)[2]?.[1]).toMatchObject({
      deferredReason: 'waiting_for_foreground_turn',
      repeatsSinceLastLog: 0,
    });
  });

  it('keeps message content out of the diagnostic', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
    });
    await consumer.drainPending({ reason: 'no-pending' });
    const [call] = noInputLogCalls(infoFile);
    expect(call?.[1]).toMatchObject({ source: 'drainPending', resultType: 'no_pending' });
    expect(Object.keys(call?.[1] as object).sort()).toEqual([
      'activeTurnSteerability',
      'repeatsSinceLastLog',
      'resultType',
      'source',
    ]);
  });
});

describe('SessionProviderInputConsumer input-wait diagnostics around the Runtime Activity tail wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the first runtime_activity_unknown answer before waiting on the tail, and not again when the retry materializes', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const tailChanged = createDeferred<boolean>();
    let tail = unsettledTail;
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({ type: 'deferred', reason: 'runtime_activity_unknown' })
      .mockImplementationOnce(async () => {
        messageQueue.push('after-exact-idle', { id: 'mode' });
        return { type: 'materialized', localId: 'after-exact-idle', seq: null, content: null };
      });
    const waitForRuntimeActivitySnapshotTailChange = vi.fn(async () => await tailChanged.promise);
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        readRuntimeActivitySnapshotTail: () => tail,
        waitForRuntimeActivitySnapshotTailChange,
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });
    const controller = new AbortController();
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });

    await vi.waitFor(() => expect(waitForRuntimeActivitySnapshotTailChange).toHaveBeenCalledTimes(1));
    // The tail is still unsettled: the answer must already be in the log.
    expect(noInputLogCalls(infoFile)).toEqual([[
      NO_INPUT_LOG,
      expect.objectContaining({
        source: 'waitForNextInput',
        resultType: 'deferred',
        deferredReason: 'runtime_activity_unknown',
        pendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    ]]);

    tail = settledIdleTail;
    tailChanged.resolve(true);
    await expect(waiting).resolves.toMatchObject({ message: 'after-exact-idle' });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    expect(noInputLogCalls(infoFile)).toHaveLength(1);
    controller.abort();
  });

  it('accounts for both the first deferral and a non-materialized retry answer exactly once each in a drain', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const tailChanged = createDeferred<boolean>();
    let tail = unsettledTail;
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({ type: 'deferred', reason: 'runtime_activity_unknown' })
      .mockResolvedValueOnce({ type: 'no_pending' });
    const waitForRuntimeActivitySnapshotTailChange = vi.fn(async () => await tailChanged.promise);
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        readRuntimeActivitySnapshotTail: () => tail,
        waitForRuntimeActivitySnapshotTailChange,
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    const drain = consumer.drainPending({ reason: 'tail-wait-drain' });
    await vi.waitFor(() => expect(waitForRuntimeActivitySnapshotTailChange).toHaveBeenCalledTimes(1));
    expect(noInputLogCalls(infoFile)).toHaveLength(1);
    expect(noInputLogCalls(infoFile)[0]?.[1]).toMatchObject({
      source: 'drainPending',
      resultType: 'deferred',
      deferredReason: 'runtime_activity_unknown',
    });

    tail = settledIdleTail;
    tailChanged.resolve(true);
    await expect(drain).resolves.toMatchObject({ materialized: 0, stoppedReason: 'no_pending' });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    expect(noInputLogCalls(infoFile).map((call) => (call[1] as { resultType: string }).resultType))
      .toEqual(['deferred', 'no_pending']);
  });
});

describe('SessionProviderInputConsumer deferral retryAfterMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-checks a deferred answer after its retryAfterMs without an external wake', async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const waitForPendingEligibilityUpdate = vi.fn(waitForAbortOnly);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({ type: 'deferred', reason: 'waiting_for_runtime_activity', retryAfterMs: 5_000 })
      .mockImplementationOnce(async () => {
        messageQueue.push('runtime became idle', { id: 'mode' }, { userMessageLocalId: 'local-recheck' });
        return { type: 'materialized', localId: 'local-recheck', seq: 3, content: null };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate,
      },
    });
    const controller = new AbortController();
    let settled = false;
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    await expect(waiting).resolves.toMatchObject({
      message: 'runtime became idle',
      userMessageLocalIds: ['local-recheck'],
    });
    controller.abort();
  });

  it('still waits for a wake when a deferral carries no retryAfterMs', async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const materializeNextPendingMessageSafely = vi.fn(async (): Promise<MaterializeNextPendingResult> => ({
      type: 'deferred',
      reason: 'waiting_for_runtime_activity',
    }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: waitForAbortOnly,
      },
    });
    const controller = new AbortController();
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(waiting).resolves.toBeNull();
  });
});
