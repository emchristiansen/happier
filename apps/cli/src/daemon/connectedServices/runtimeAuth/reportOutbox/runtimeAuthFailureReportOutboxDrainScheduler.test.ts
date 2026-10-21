import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests,
  scheduleRuntimeAuthFailureReportOutboxDrainToDaemon,
} from './runtimeAuthFailureReportOutboxDrainScheduler';
import type { RuntimeAuthFailureReportOutboxItem } from './runtimeAuthFailureReportOutboxTypes';

function buildQueuedItem(input: Readonly<{
  reportId: string;
  sessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  attemptCount: number;
}>): RuntimeAuthFailureReportOutboxItem {
  return {
    schemaVersion: 1,
    fileId: `report-${input.reportId}`,
    reportKey: `runtime-auth-failure-report:v1:${input.reportId}`,
    reportId: input.reportId,
    sessionId: input.sessionId,
    switchesThisTurn: 0,
    classification: {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    },
    attemptCount: input.attemptCount,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
  };
}

const peekNothingQueued = async (): Promise<RuntimeAuthFailureReportOutboxItem[]> => [];

describe('runtimeAuthFailureReportOutboxDrainScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
  });

  afterEach(() => {
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
    vi.useRealTimers();
  });

  it('coalesces duplicate schedules into one outbox drain', async () => {
    const drain = vi.fn(async () => ({ delivered: 1, dropped: 0, retried: 0 }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
      peekQueuedItems: peekNothingQueued,
    });
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
      peekQueuedItems: peekNothingQueued,
    });

    expect(drain).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(drain).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledWith({
      outboxDir: '/tmp/outbox',
      limit: 8,
    });
  });

  it('backs off and retries when daemon intake keeps queued reports retryable', async () => {
    const drain = vi
      .fn()
      .mockResolvedValueOnce({ delivered: 0, dropped: 0, retried: 1 })
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
      peekQueuedItems: peekNothingQueued,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stops after three automatic attempts and allows a later trigger to retry the retained item', async () => {
    const drain = vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 1 }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      maxAutomaticAttempts: 3,
      drain,
      peekQueuedItems: peekNothingQueued,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(200);
    expect(drain).toHaveBeenCalledTimes(3);

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
      peekQueuedItems: peekNothingQueued,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(drain).toHaveBeenCalledTimes(4);
  });

  it('keeps retrying within the bounded daemon-replacement horizon', async () => {
    const drain = vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 1 }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
      peekQueuedItems: peekNothingQueued,
    });

    await vi.advanceTimersByTimeAsync(10);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await vi.advanceTimersByTimeAsync(20 * (2 ** (attempt - 1)));
    }

    expect(drain).toHaveBeenCalledTimes(8);
  });
  it('warns once with the oldest queued report when the automatic chain stops with reports still queued', async () => {
    const drain = vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 2 }));
    const peekQueuedItems = vi.fn(async () => [
      buildQueuedItem({
        reportId: 'runtime-auth-report:older',
        sessionId: 'session-older',
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_030_000,
        attemptCount: 4,
      }),
      buildQueuedItem({
        reportId: 'runtime-auth-report:newer',
        sessionId: 'session-newer',
        createdAtMs: 1_700_000_010_000,
        updatedAtMs: 1_700_000_010_000,
        attemptCount: 1,
      }),
    ]);
    const logger = { debug: vi.fn(), warn: vi.fn() };

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/outbox-under-test',
      delayMs: 10,
      retryDelayMs: 20,
      maxAutomaticAttempts: 3,
      nowMs: () => 1_700_000_090_000,
      logger,
      logPrefix: '[test]',
      drain,
      peekQueuedItems,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(peekQueuedItems).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(drain).toHaveBeenCalledTimes(3);
    expect(peekQueuedItems).toHaveBeenCalledOnce();
    expect(peekQueuedItems).toHaveBeenCalledWith({ outboxDir: '/outbox-under-test' });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      '[test] Connected-service runtime auth failure report outbox automatic drain chain stopped with reports still queued',
      {
        automaticPasses: 3,
        maxAutomaticPasses: 3,
        stopReason: 'automatic_pass_limit_reached',
        queuedItemCount: 2,
        oldestQueuedItem: {
          reportId: 'runtime-auth-report:older',
          sessionId: 'session-older',
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_030_000,
          ageSinceCreatedMs: 90_000,
          attemptCount: 4,
        },
      },
    );
  });

  it('warns when the last pass left reports queued without a retryable delivery', async () => {
    const drain = vi.fn(async () => ({ delivered: 8, dropped: 0, retried: 0 }));
    const peekQueuedItems = vi.fn(async () => [
      buildQueuedItem({
        reportId: 'runtime-auth-report:beyond-limit',
        sessionId: 'session-beyond-limit',
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
        attemptCount: 1,
      }),
    ]);
    const logger = { debug: vi.fn(), warn: vi.fn() };

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      nowMs: () => 1_700_000_005_000,
      logger,
      logPrefix: '[test]',
      drain,
      peekQueuedItems,
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(drain).toHaveBeenCalledOnce();
    expect(peekQueuedItems).toHaveBeenCalledWith({});
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      automaticPasses: 1,
      maxAutomaticPasses: 8,
      stopReason: 'last_pass_left_nothing_retryable',
      queuedItemCount: 1,
      oldestQueuedItem: expect.objectContaining({
        reportId: 'runtime-auth-report:beyond-limit',
        ageSinceCreatedMs: 5_000,
      }),
    }));
  });

  it('does not warn when the automatic chain drains the outbox clean', async () => {
    const drain = vi
      .fn()
      .mockResolvedValueOnce({ delivered: 0, dropped: 0, retried: 1 })
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });
    const peekQueuedItems = vi.fn(peekNothingQueued);
    const logger = { debug: vi.fn(), warn: vi.fn() };

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      logger,
      drain,
      peekQueuedItems,
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(peekQueuedItems).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
