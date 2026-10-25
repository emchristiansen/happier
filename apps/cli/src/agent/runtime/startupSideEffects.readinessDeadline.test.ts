import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The deadline must hold through the real control client, so only its two edges are replaced:
// the daemon-state preflight and the HTTP exchange. Timeout resolution, its 100 ms floor and the
// abort wiring are the production code.
const { readDaemonStateMock } = vi.hoisted(() => ({ readDaemonStateMock: vi.fn() }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readDaemonState: readDaemonStateMock,
}));

import {
  DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS,
  reportSessionToDaemonIfRunning,
} from '@/agent/runtime/startupSideEffects';
import type { Metadata } from '@/api/types';

const READINESS_NOT_ACKNOWLEDGED = 'Claude runtime readiness was not acknowledged by the daemon';
const DAEMON_STATE = { pid: process.pid, httpPort: 65_535, controlToken: 'control-token' };
/** Remaining ceiling at the final attempt: below the control client's 100 ms explicit-timeout floor. */
const REMAINING_AT_FINAL_ATTEMPT_MS = 50;
/** How long the daemon (or its state file) takes in the final attempt: past the ceiling, within the floor. */
const FINAL_ATTEMPT_LATENCY_MS = 80;

function pendingAnswer(): Response {
  return new Response(JSON.stringify({
    error: 'Session startup reconciliation is still settling',
    errorCode: 'session_startup_reconciliation_pending',
  }), { status: 503, headers: { 'content-type': 'application/json' } });
}

/** Resolves `value` after `ms` of real time unless `signal` aborts first, as fetch does. */
function settleAfter<T>(ms: number, value: () => T, signal?: AbortSignal | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => resolve(value()), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * A real clock shifted so that the pause after the daemon's first pending answer ends exactly
 * `remainingMs` before the ceiling, as at elapsed 599950 ms in the production schedule.
 */
function clockLandingBeforeCeiling(remainingMs: number) {
  let skewMs = 0;
  let startedAt: number | undefined;
  const nowFn = (): number => {
    const now = Date.now() + skewMs;
    startedAt ??= now;
    return now;
  };
  return {
    nowFn,
    sleepFn: async (): Promise<void> => {
      skewMs = startedAt! + DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS - remainingMs - Date.now();
    },
    remainingMs: (): number => startedAt! + DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS - nowFn(),
  };
}

describe('daemon readiness report: the ten-minute ceiling is a deadline through the control client', () => {
  beforeEach(() => {
    readDaemonStateMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not let the control client stretch a final attempt with under 100 ms left past the ceiling', async () => {
    readDaemonStateMock.mockResolvedValue(DAEMON_STATE);
    const clock = clockLandingBeforeCeiling(REMAINING_AT_FINAL_ATTEMPT_MS);
    const remainingAtRequestMs: number[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      remainingAtRequestMs.push(clock.remainingMs());
      if (fetchMock.mock.calls.length === 1) return pendingAnswer();
      return await settleAfter(FINAL_ATTEMPT_LATENCY_MS, () => Response.json({ status: 'ok' }), init?.signal);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onReported = vi.fn();

    await expect(reportSessionToDaemonIfRunning(
      { sessionId: 'session-deadline-floor', metadata: { startedBy: 'daemon' } as Metadata, requireDaemonAck: true },
      { nowFn: clock.nowFn, sleepFn: clock.sleepFn, onReported },
    )).rejects.toThrow(READINESS_NOT_ACKNOWLEDGED);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(remainingAtRequestMs[1]).toBeLessThan(100);
    expect(onReported).not.toHaveBeenCalled();
  });

  it('counts the daemon-state preflight against the ceiling', async () => {
    readDaemonStateMock
      .mockResolvedValueOnce(DAEMON_STATE)
      .mockImplementationOnce(async () => await settleAfter(FINAL_ATTEMPT_LATENCY_MS, () => DAEMON_STATE));
    const clock = clockLandingBeforeCeiling(REMAINING_AT_FINAL_ATTEMPT_MS);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return pendingAnswer();
      return await settleAfter(0, () => Response.json({ status: 'ok' }), init?.signal);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onReported = vi.fn();

    await expect(reportSessionToDaemonIfRunning(
      { sessionId: 'session-deadline-preflight', metadata: { startedBy: 'daemon' } as Metadata, requireDaemonAck: true },
      { nowFn: clock.nowFn, sleepFn: clock.sleepFn, onReported },
    )).rejects.toThrow(READINESS_NOT_ACKNOWLEDGED);

    expect(readDaemonStateMock).toHaveBeenCalledTimes(2);
    expect(onReported).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement that settles after the ceiling', async () => {
    // The caller's own check, independent of how the lower layer bounds the request.
    const clock = { now: 0 };
    let attempts = 0;

    await expect(reportSessionToDaemonIfRunning(
      { sessionId: 'session-deadline-late-success', metadata: { startedBy: 'daemon' } as Metadata, requireDaemonAck: true },
      {
        notifyDaemonSessionStartedFn: async () => {
          attempts += 1;
          if (attempts === 1) {
            clock.now = DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS - REMAINING_AT_FINAL_ATTEMPT_MS;
            return {
              error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_pending)',
              errorCode: 'session_startup_reconciliation_pending',
            };
          }
          clock.now += FINAL_ATTEMPT_LATENCY_MS;
          return { status: 'ok' };
        },
        sleepFn: async () => {},
        nowFn: () => clock.now,
      },
    )).rejects.toThrow(READINESS_NOT_ACKNOWLEDGED);

    expect(attempts).toBe(2);
  });
});
