import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  infoFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({ logger: loggerMocks }));

import { publishSessionPendingQueueWake } from './publishSessionPendingQueueWake';

describe('publishSessionPendingQueueWake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a fulfilled unavailable result instead of silently discarding it', async () => {
    publishSessionPendingQueueWake({
      sessionId: 'sess-terminating',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'unavailable', reason: 'runtime_terminating' }),
    });

    await vi.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake unavailable',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-terminating',
        trigger: 'attach',
        outcome: 'unavailable',
        reason: 'runtime_terminating',
      },
    ));
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });

  it('records a published wake without changing the fire-and-forget contract', async () => {
    publishSessionPendingQueueWake({
      sessionId: 'sess-live',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'wake_published' }),
    });

    await vi.waitFor(() => expect(loggerMocks.infoFile).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake published',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-live',
        trigger: 'attach',
        outcome: 'published',
      },
    ));
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('records a safe error outcome while retaining detailed rejection at debug level', async () => {
    const requestError = new Error('wake transport failed');
    publishSessionPendingQueueWake({
      sessionId: 'sess-rpc-failed',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => { throw requestError; },
    });

    await vi.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake failed',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-rpc-failed',
        trigger: 'attach',
        outcome: 'error',
      },
    ));
    expect(loggerMocks.debug).toHaveBeenCalledOnce();
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });

  it('does not request or report a wake after shutdown starts', async () => {
    const requestWake = vi.fn(async () => ({ type: 'wake_published' as const }));
    publishSessionPendingQueueWake({
      sessionId: 'sess-shutdown',
      isShutdownRequested: () => true,
      logLabel: 'attach',
      requestWake,
    });
    await Promise.resolve();

    expect(requestWake).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });
  it('logs the blocking queue head the server reports in session state after a published wake', async () => {
    const readBlockingHead = vi.fn(async () => ({
      localId: 'head-1',
      deliveryState: 'blocked' as const,
      blockedReason: 'provider_unavailable_before_acceptance' as const,
      lastUpdatedAt: 1_700_000_000_000,
      ageSinceLastUpdateMs: 120_000,
    }));
    publishSessionPendingQueueWake({
      sessionId: 'sess-stalled',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'wake_published' }),
      readBlockingHead,
    });

    await vi.waitFor(() => expect(loggerMocks.infoFile).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue head is holding back ordinary pending input',
      {
        event: 'pending_queue_blocking_head',
        sessionId: 'sess-stalled',
        trigger: 'attach',
        localId: 'head-1',
        deliveryState: 'blocked',
        blockedReason: 'provider_unavailable_before_acceptance',
        lastUpdatedAt: 1_700_000_000_000,
        ageSinceLastUpdateMs: 120_000,
      },
    ));
    expect(readBlockingHead).toHaveBeenCalledOnce();
  });

  it('logs nothing more when the server reports no blocking head, and never reads it after an unavailable wake', async () => {
    const readNoHead = vi.fn(async () => null);
    publishSessionPendingQueueWake({
      sessionId: 'sess-flowing',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'wake_published' }),
      readBlockingHead: readNoHead,
    });
    await vi.waitFor(() => expect(readNoHead).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(loggerMocks.infoFile).toHaveBeenCalledTimes(1);

    const readAfterUnavailable = vi.fn(async () => null);
    publishSessionPendingQueueWake({
      sessionId: 'sess-unavailable',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'unavailable', reason: 'runtime_terminating' }),
      readBlockingHead: readAfterUnavailable,
    });
    await vi.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalled());
    expect(readAfterUnavailable).not.toHaveBeenCalled();
  });
});
