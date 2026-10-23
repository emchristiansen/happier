import { describe, expect, it, vi } from 'vitest';

import {
  DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS,
  DAEMON_STARTED_REPORT_ATTEMPT_TIMEOUT_MS,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  resolveTerminalAttachmentPersistenceBinding,
} from '@/agent/runtime/startupSideEffects';
import type { Metadata } from '@/api/types';
import { SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS } from '@/daemon/sessionStartedReadiness';

const metadataStub = {} as Metadata;

describe('startup side effects: daemon session reporting retry', () => {
  it('resolves the existing bound tmux identity for local attachment persistence', () => {
    expect(resolveTerminalAttachmentPersistenceBinding({
      mode: 'tmux',
      tmux: { target: 'happy:window-1', tmpDir: '/tmp/custom-tmux' },
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'servable',
        observedAt: 1,
      },
    })).toMatchObject({
      attachmentId: 'attachment-1',
      handle: {
        attachmentId: 'attachment-1',
        kind: 'tmux',
        sessionName: 'happy',
        paneId: 'window-1',
        socketDir: '/tmp/custom-tmux',
      },
    });
  });

  it('reports newer concurrent metadata even when the older in-flight report succeeds', async () => {
    let releaseFirstAttempt!: (value: { error?: string }) => void;
    const firstAttempt = new Promise<{ error?: string }>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const observedMetadata: Metadata[] = [];
    const notifyDaemonSessionStartedFn = vi.fn(async (_sessionId: string, metadata: Metadata) => {
      observedMetadata.push(metadata);
      return observedMetadata.length === 1 ? await firstAttempt : {};
    });
    const deps = { notifyDaemonSessionStartedFn };

    const first = reportSessionToDaemonIfRunning(
      { sessionId: 'session-newer-metadata', metadata: { startedBy: 'terminal' } as Metadata },
      deps,
    );
    await vi.waitFor(() => expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(1));
    const latestMetadata = { startedBy: 'daemon', claudeSessionId: 'claude-current' } as Metadata;
    const second = reportSessionToDaemonIfRunning(
      { sessionId: 'session-newer-metadata', metadata: latestMetadata, requireDaemonAck: true },
      deps,
    );

    releaseFirstAttempt({});
    await Promise.all([first, second]);

    expect(observedMetadata).toEqual([
      { startedBy: 'terminal' },
      latestMetadata,
    ]);
  });

  it('coalesces concurrent reports for one session and retries with the latest metadata and strongest readiness requirement', async () => {
    let releaseFirstAttempt!: (value: { error?: string }) => void;
    const firstAttempt = new Promise<{ error?: string }>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const observedMetadata: Metadata[] = [];
    const onFirstReported = vi.fn(async () => {});
    const onSecondReported = vi.fn(async () => {});
    let calls = 0;
    let now = 0;
    const notifyDaemonSessionStartedFn = vi.fn(async (_sessionId: string, metadata: Metadata) => {
      observedMetadata.push(metadata);
      calls += 1;
      if (calls === 1) return await firstAttempt;
      return {};
    });
    const commonDeps = {
      notifyDaemonSessionStartedFn,
      sleepFn: async (ms: number) => {
        now += ms;
      },
      nowFn: () => now,
      retryTimeoutMs: 1_000,
      retryIntervalMs: 100,
    };

    const first = reportSessionToDaemonIfRunning(
      { sessionId: 'session-coalesced', metadata: { startedBy: 'terminal' } as Metadata },
      { ...commonDeps, onReported: onFirstReported },
    );
    await vi.waitFor(() => expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(1));
    const latestMetadata = { startedBy: 'daemon', claudeSessionId: 'claude-current' } as Metadata;
    const second = reportSessionToDaemonIfRunning(
      { sessionId: 'session-coalesced', metadata: latestMetadata, requireDaemonAck: true },
      { ...commonDeps, onReported: onSecondReported },
    );

    releaseFirstAttempt({ error: 'No daemon running, no state file found' });
    await Promise.all([first, second]);

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(2);
    expect(observedMetadata).toEqual([
      { startedBy: 'terminal' },
      latestMetadata,
    ]);
    expect(onFirstReported).toHaveBeenCalledTimes(1);
    expect(onSecondReported).toHaveBeenCalledTimes(1);
  });

  it('does not emit unhandledRejection when priming agent state fails', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = {
        updateAgentState: async () => {
          throw new Error('updateAgentState failed');
        },
      };

      primeAgentStateForUi(session as any, '[Test]');

      // Give Node a chance to surface an unhandled rejection if one was created.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('retries transient daemon-unavailable errors and succeeds', async () => {
    const errors = [
      { error: 'No daemon running, no state file found' },
      { error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_failed)' },
      {},
    ];
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-1', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async () => {
          const next = errors[calls] ?? {};
          calls++;
          return next;
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 1_000,
        retryIntervalMs: 100,
      },
    );

    expect(calls).toBe(3);
  });

  it('invokes the daemon-reported callback after a retry succeeds', async () => {
    const errors = [
      { error: 'No daemon running, no state file found' },
      {},
    ];
    let calls = 0;
    let now = 0;
    const onReported = vi.fn(async () => {});

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-reported', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async () => {
          const next = errors[calls] ?? {};
          calls++;
          return next;
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 1_000,
        retryIntervalMs: 100,
        onReported,
      },
    );

    expect(calls).toBe(2);
    expect(onReported).toHaveBeenCalledTimes(1);
  });

  it('retries daemon report when control auth is temporarily out of sync', async () => {
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-2', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async () => {
          calls++;
          return { error: 'Unauthorized' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 1_000,
        retryIntervalMs: 100,
      },
    );

    expect(calls).toBeGreaterThan(1);
  });

  it('uses a bounded HTTP timeout per daemon-report attempt', async () => {
    const observedTimeouts: Array<number | null | undefined> = [];

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-3', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return {};
        },
      },
    );

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-3b', metadata: { startedBy: 'daemon' } as Metadata },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return {};
        },
      },
    );

    expect(observedTimeouts).toEqual([2_500, DAEMON_STARTED_REPORT_ATTEMPT_TIMEOUT_MS]);
  });

  it('uses a longer default retry window for daemon-started sessions', async () => {
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-4', metadata: { startedBy: 'daemon' } as Metadata },
      {
        notifyDaemonSessionStartedFn: async () => {
          calls++;
          return { error: 'No daemon running, no state file found' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryIntervalMs: 30_000,
      },
    );

    // With retryInterval=30s and daemon-default retryTimeout=90s, we should observe:
    // attempt at t=0, 30s, 60s, 90s (then stop).
    expect(calls).toBe(4);
  });

  it('fails closed when a readiness report exhausts retries without daemon acknowledgement', async () => {
    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-readiness',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async () => ({ error: 'No daemon running, no state file found' }),
        nowFn: () => 1_000,
        retryTimeoutMs: 0,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
  });

  it('keeps a daemon-started runner waiting while a slow daemon still answers readiness', async () => {
    // 2026-10-23: the daemon answered /session-started only after its 15 s account-profile check,
    // so every 10 s attempt timed out and a runner whose daemon was alive exited FATAL after 90 s.
    const daemonAccountCheckMs = 15_000;
    const serverRecoversAtMs = 4 * 60_000;
    let now = 0;
    let answeredAttempts = 0;

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-slow-daemon',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          const attemptTimeoutMs = options?.timeoutMs ?? 0;
          if (attemptTimeoutMs <= daemonAccountCheckMs) {
            now += attemptTimeoutMs;
            return { error: 'Request failed: /session-started, The operation was aborted due to timeout' };
          }
          now += daemonAccountCheckMs;
          answeredAttempts += 1;
          if (now < serverRecoversAtMs) {
            return {
              error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_failed)',
              errorCode: 'session_startup_reconciliation_failed',
            };
          }
          return { status: 'ok' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
      },
    )).resolves.toBeUndefined();
    expect(answeredAttempts).toBeGreaterThan(1);
    expect(now).toBeGreaterThanOrEqual(serverRecoversAtMs);
  });

  it('gives up on a daemon that keeps answering readiness failures once the total ceiling passes', async () => {
    let now = 0;

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-never-ready',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async () => {
          now += 1_000;
          return {
            error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_pending)',
            errorCode: 'session_startup_reconciliation_pending',
          };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
    expect(now).toBeGreaterThanOrEqual(DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS);
    expect(now).toBeLessThan(DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS + 5_000);
  });

  /** A daemon at the production schedule: it answers "pending" at its readiness bound, or not at all within a shorter attempt. */
  function productionScheduleDaemon(params: Readonly<{
    clock: { now: number };
    readyAtMs: number;
    attemptDeadlines: number[];
  }>) {
    return async (_sessionId: string, _metadata: Metadata, options?: { timeoutMs?: number | null }) => {
      const attemptTimeoutMs = options?.timeoutMs ?? Number.POSITIVE_INFINITY;
      params.attemptDeadlines.push(params.clock.now + attemptTimeoutMs);
      if (attemptTimeoutMs < SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS) {
        params.clock.now += attemptTimeoutMs;
        return { error: 'Request failed: /session-started, The operation was aborted due to timeout' };
      }
      params.clock.now += SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS;
      if (params.clock.now >= params.readyAtMs) return { status: 'ok' };
      return {
        error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_pending)',
        errorCode: 'session_startup_reconciliation_pending',
      };
    };
  }

  it('fails a runner whose daemon stays pending exactly at the ceiling under the production answer schedule', async () => {
    const clock = { now: 0 };
    const attemptDeadlines: number[] = [];

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-pending-production-schedule',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: productionScheduleDaemon({
          clock,
          readyAtMs: Number.POSITIVE_INFINITY,
          attemptDeadlines,
        }),
        sleepFn: async (ms) => {
          clock.now += ms;
        },
        nowFn: () => clock.now,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
    expect(clock.now).toBeLessThanOrEqual(DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS);
    expect(Math.max(...attemptDeadlines)).toBeLessThanOrEqual(DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS);
  });

  it('does not accept a readiness answer the daemon could only give after the ceiling', async () => {
    const clock = { now: 0 };
    const attemptDeadlines: number[] = [];

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-ready-after-ceiling',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: productionScheduleDaemon({
          clock,
          readyAtMs: DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS + 1,
          attemptDeadlines,
        }),
        sleepFn: async (ms) => {
          clock.now += ms;
        },
        nowFn: () => clock.now,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
    expect(clock.now).toBeLessThanOrEqual(DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS);
  });

  it('still fails a daemon-started runner whose daemon never answers', async () => {
    let now = 0;
    let attempts = 0;

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-dead-daemon',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async () => {
          attempts += 1;
          now += 5;
          return { error: 'Request failed: /session-started, fetch failed' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
    expect(attempts).toBeGreaterThan(1);
    expect(now).toBeGreaterThanOrEqual(90_000);
    expect(now).toBeLessThan(91_000);
  });

  it('uses a longer default retry window when daemon autostart is enabled for terminal sessions', async () => {
    const previousAutostart = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';

    try {
      let calls = 0;
      let now = 0;

      await reportSessionToDaemonIfRunning(
        { sessionId: 'session-5', metadata: metadataStub },
        {
          notifyDaemonSessionStartedFn: async () => {
            calls++;
            return { error: 'No daemon running, no state file found' };
          },
          sleepFn: async (ms) => {
            now += ms;
          },
          nowFn: () => now,
          retryIntervalMs: 10_000,
        },
      );

      // With daemon autostart enabled we should keep retrying past the old 10s terminal window:
      // attempt at t=0, 10s, 20s, 30s (then stop).
      expect(calls).toBe(4);
    } finally {
      if (previousAutostart === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
      else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = previousAutostart;
    }
  });
});
