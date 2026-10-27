import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

const readSessionArchiveState = vi.hoisted(() => vi.fn());
vi.mock('@/session/services/readSessionArchiveState', () => ({
  readSessionArchiveState: (...args: unknown[]) => readSessionArchiveState(...args),
}));

import { SessionArchiveInputAdmission } from './sessionArchiveInputAdmission';

const RETRY_LOG = '[archiveAdmission] archive state read failed; retrying';

describe('SessionArchiveInputAdmission diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    readSessionArchiveState.mockReset();
  });

  it('logs each failed admission read with its retry schedule, then admits on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    readSessionArchiveState
      .mockResolvedValueOnce({ kind: 'unavailable', retryAfterMs: 2_000 })
      .mockResolvedValueOnce({ kind: 'unarchived' });
    const lifetime = new AbortController();
    const admission = new SessionArchiveInputAdmission({
      token: 'token-not-logged',
      sessionId: 'session-archive-diag',
      lifetime: lifetime.signal,
      connectionEpoch: () => 1,
      waitForFreshEvent: async (signal) => await new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
      requestArchivedStop: async () => ({ kind: 'requested' }),
    });

    const admitted = admission.wait(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const retryLogs = infoFile.mock.calls.filter((call) => call[0] === RETRY_LOG);
    expect(retryLogs).toHaveLength(1);
    expect(retryLogs[0]?.[1]).toMatchObject({
      sessionId: 'session-archive-diag',
      cause: 'unavailable',
      serverRetryAfterMs: 2_000,
      failedAttempts: 1,
      status: 'retrying',
    });
    expect(JSON.stringify(retryLogs[0]?.[1])).not.toContain('token-not-logged');

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(admitted).resolves.toBe(true);
    expect(infoFile.mock.calls.filter((call) => call[0] === RETRY_LOG)).toHaveLength(1);
    lifetime.abort();
  });

  it('logs a connection-epoch change during the read as the retry cause', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    let epoch = 1;
    readSessionArchiveState
      .mockImplementationOnce(async () => {
        epoch = 2;
        return { kind: 'unarchived' };
      })
      .mockResolvedValueOnce({ kind: 'unarchived' });
    const lifetime = new AbortController();
    const admission = new SessionArchiveInputAdmission({
      token: 'token',
      sessionId: 'session-archive-epoch',
      lifetime: lifetime.signal,
      connectionEpoch: () => epoch,
      waitForFreshEvent: async (signal) => await new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
      requestArchivedStop: async () => ({ kind: 'requested' }),
    });

    await expect(admission.wait(new AbortController().signal)).resolves.toBe(true);
    const retryLogs = infoFile.mock.calls.filter((call) => call[0] === RETRY_LOG);
    expect(retryLogs).toHaveLength(1);
    expect(retryLogs[0]?.[1]).toMatchObject({ sessionId: 'session-archive-epoch', cause: 'connection_epoch_changed' });
    lifetime.abort();
  });
});
