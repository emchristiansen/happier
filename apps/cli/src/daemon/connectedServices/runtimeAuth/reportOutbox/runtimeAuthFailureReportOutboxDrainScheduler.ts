import { logger as defaultLogger } from '@/ui/logger';
import { peekRuntimeAuthFailureReportOutboxItems } from './runtimeAuthFailureReportOutbox';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';

type RuntimeAuthFailureReportOutboxDrainLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
  /** Report-path callers may pass a debug-only logger; the chain-end warning then uses the default logger. */
  warn?: (message: string, fields: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_DRAIN_DELAY_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_DRAIN_LIMIT = 8;
const DEFAULT_MAX_AUTOMATIC_ATTEMPTS = 8;

let scheduledTimer: Timer | null = null;
let drainInFlight = false;

function clearScheduledTimer(clearTimeoutFn: typeof clearTimeout = clearTimeout): void {
  if (!scheduledTimer) return;
  clearTimeoutFn(scheduledTimer);
  scheduledTimer = null;
}

function unrefTimer(timer: Timer): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') {
    maybeUnref.call(timer);
  }
}

function readDelayMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

export function resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests(): void {
  clearScheduledTimer();
  drainInFlight = false;
}

type DrainScheduleInput = Readonly<{
  outboxDir?: string;
  logger?: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix?: string;
  delayMs?: number;
  retryDelayMs?: number;
  maxAutomaticAttempts?: number;
  limit?: number;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  drain?: typeof drainRuntimeAuthFailureReportOutboxToDaemon;
  peekQueuedItems?: typeof peekRuntimeAuthFailureReportOutboxItems;
}>;

function readMaxAutomaticAttempts(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_AUTOMATIC_ATTEMPTS;
}

function scheduleDrain(input: DrainScheduleInput, automaticAttempt: number): void {
  if (scheduledTimer || drainInFlight) return;

  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const delayMs = readDelayMs(input.delayMs, DEFAULT_DRAIN_DELAY_MS);
  scheduledTimer = setTimeoutFn(() => {
    clearScheduledTimer(clearTimeoutFn);
    void drainOnce(input, automaticAttempt);
  }, delayMs);
  unrefTimer(scheduledTimer);
}

export function scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(
  input: DrainScheduleInput = {},
): void {
  scheduleDrain(input, 1);
}

async function drainOnce(input: DrainScheduleInput, automaticAttempt: number): Promise<void> {
  if (drainInFlight) return;

  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const drain = input.drain ?? drainRuntimeAuthFailureReportOutboxToDaemon;
  let shouldRetry = false;

  drainInFlight = true;
  try {
    const result = await drain({
      ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
      limit: input.limit ?? DEFAULT_DRAIN_LIMIT,
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });
    shouldRetry = result.retried > 0;
  } catch (error) {
    shouldRetry = true;
    logger.debug(`${logPrefix} Failed to drain connected-service runtime auth failure report outbox (non-fatal)`, error);
  } finally {
    drainInFlight = false;
  }

  const maxAutomaticAttempts = readMaxAutomaticAttempts(input.maxAutomaticAttempts);
  if (shouldRetry && automaticAttempt < maxAutomaticAttempts) {
    const retryDelayMs = readDelayMs(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    scheduleDrain({
      ...input,
      delayMs: Math.min(
        retryDelayMs * (2 ** Math.max(0, automaticAttempt - 1)),
        DEFAULT_MAX_RETRY_DELAY_MS,
      ),
    }, automaticAttempt + 1);
    return;
  }

  await warnIfAutomaticDrainChainStoppedWithQueuedItems({
    input,
    logger,
    logPrefix,
    automaticPasses: automaticAttempt,
    maxAutomaticPasses: maxAutomaticAttempts,
    stopReason: shouldRetry ? 'automatic_pass_limit_reached' : 'last_pass_left_nothing_retryable',
  });
}

// Diagnostic only: observes the outbox after the automatic chain has already stopped. It neither
// re-arms the chain nor changes any queued item; a later report or daemon start drains them as before.
async function warnIfAutomaticDrainChainStoppedWithQueuedItems(params: Readonly<{
  input: DrainScheduleInput;
  logger: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix: string;
  automaticPasses: number;
  maxAutomaticPasses: number;
  stopReason: 'automatic_pass_limit_reached' | 'last_pass_left_nothing_retryable';
}>): Promise<void> {
  const peekQueuedItems = params.input.peekQueuedItems ?? peekRuntimeAuthFailureReportOutboxItems;
  let queuedItems: Awaited<ReturnType<typeof peekRuntimeAuthFailureReportOutboxItems>>;
  try {
    queuedItems = await peekQueuedItems({
      ...(params.input.outboxDir ? { outboxDir: params.input.outboxDir } : {}),
    });
  } catch (error) {
    params.logger.debug(
      `${params.logPrefix} Failed to read connected-service runtime auth failure report outbox after the automatic drain chain stopped (non-fatal)`,
      error,
    );
    return;
  }
  const oldest = queuedItems[0];
  if (!oldest) return;
  const nowMs = params.input.nowMs?.() ?? Date.now();
  const message = `${params.logPrefix} Connected-service runtime auth failure report outbox automatic drain chain stopped with reports still queued`;
  const fields = {
    automaticPasses: params.automaticPasses,
    maxAutomaticPasses: params.maxAutomaticPasses,
    stopReason: params.stopReason,
    queuedItemCount: queuedItems.length,
    oldestQueuedItem: {
      reportId: oldest.reportId,
      sessionId: oldest.sessionId,
      createdAtMs: oldest.createdAtMs,
      updatedAtMs: oldest.updatedAtMs,
      ageSinceCreatedMs: nowMs - oldest.createdAtMs,
      attemptCount: oldest.attemptCount,
    },
  };
  if (params.logger.warn) {
    params.logger.warn(message, fields);
    return;
  }
  defaultLogger.warn(message, fields);
}
