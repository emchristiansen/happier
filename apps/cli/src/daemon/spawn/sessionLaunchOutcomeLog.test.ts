import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveSessionLaunchPlacement,
  type SessionLaunchPlacementOutcome,
} from '@/daemon/platform/linux/observeSessionLaunchPlacement';
import type { SessionLaunchId } from '@/daemon/platform/linux/sessionLaunchId';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';
import { startSessionLaunchOutcomeLog } from './sessionLaunchOutcomeLog';
import { settlePendingSpawnBeforeWebhook } from './settlePendingSpawnBeforeWebhook';
import { waitForSessionWebhook } from './waitForSessionWebhook';

const LAUNCH_ID = '6e5d4c3b-2a19-4f8e-8d7c-6b5a49382716' as SessionLaunchId;
const UNIT = `happier-launch-${LAUNCH_ID}.scope`;

function captureWriter() {
  const lines: string[] = [];
  return {
    lines,
    write: {
      info: (line: string) => lines.push(`INFO ${line}`),
      warn: (line: string) => lines.push(`WARN ${line}`),
    },
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function spawnMaps() {
  return {
    pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
    pidToSpawnResultResolver: new Map<number, (result: SpawnSessionResult) => void>(),
    pidToSpawnWebhookTimeout: new Map<number, NodeJS.Timeout>(),
  };
}

const childExitResult: SpawnSessionResult = {
  type: 'error',
  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
  errorMessage: 'Child process exited before session webhook (pid=4242, code=0, signal=null)',
};

describe('startSessionLaunchOutcomeLog', () => {
  it.each<[string, SessionLaunchPlacementOutcome, string]>([
    ['an observed scope', { outcome: 'scoped', unitName: UNIT }, `outcome=scoped unit=${UNIT}`],
    ['a missing user bus', { outcome: 'unscoped', probe: { kind: 'no-user-bus' } }, 'outcome=unscoped reason=no-user-bus'],
    [
      'an unprovisioned slice',
      { outcome: 'unscoped', probe: { kind: 'slice-mismatch', property: 'CPUWeight', expected: '50', actual: '[not set]' } },
      'outcome=unscoped reason=slice-mismatch property=CPUWeight expected=50 actual="[not set]"',
    ],
    [
      'the runtime disable override',
      { outcome: 'unscoped', probe: { kind: 'slice-mismatch', property: 'CPUWeight', expected: '50', actual: '49' } },
      'outcome=unscoped reason=slice-mismatch property=CPUWeight expected=50 actual=49',
    ],
    ['a probe timeout', { outcome: 'unscoped', probe: { kind: 'probe-timeout' } }, 'outcome=unscoped reason=probe-timeout'],
    [
      'a probe error',
      { outcome: 'unscoped', probe: { kind: 'probe-error', message: 'Failed to connect to bus' } },
      'outcome=unscoped reason=probe-error message="Failed to connect to bus"',
    ],
    [
      'an unestablished placement',
      { outcome: 'unknown', lastCgroup: '/system.slice/happier-daemon.service', reason: { kind: 'bound-elapsed' } },
      'outcome=unknown last_cgroup=/system.slice/happier-daemon.service reason=bound-elapsed',
    ],
    [
      'a vanished runner',
      { outcome: 'unknown', lastCgroup: null, reason: { kind: 'pid-gone' } },
      'outcome=unknown last_cgroup=none reason=pid-gone',
    ],
    [
      'an unreadable cgroup',
      { outcome: 'unknown', lastCgroup: null, reason: { kind: 'read-error', message: 'EACCES: permission denied' } },
      'outcome=unknown last_cgroup=none reason=read-error message="EACCES: permission denied"',
    ],
  ])('writes exactly one launch-placement line for %s', async (_label, outcome, expectedTail) => {
    const capture = captureWriter();
    startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'child',
      existingSessionId: '',
      pid: 4242,
      placement: Promise.resolve(outcome),
      write: capture.write,
    });
    await settled();

    expect(capture.lines).toEqual([
      `INFO launch-placement launch=${LAUNCH_ID} session=pending mode=child pid=4242 ${expectedTail}`,
    ]);
  });

  it('names the resumed session at launch and binds a new one only from its webhook', async () => {
    const capture = captureWriter();
    const resumed = startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'tmux',
      existingSessionId: 'sess_existing',
      pid: 5151,
      placement: Promise.resolve({ outcome: 'unscoped', probe: { kind: 'no-user-bus' } }),
      write: capture.write,
    });
    resumed.sessionBound('sess_existing');
    await settled();

    // The lines correlate by launch id; their relative order is not guaranteed.
    expect([...capture.lines].sort()).toEqual([
      `INFO launch-placement launch=${LAUNCH_ID} session=sess_existing mode=tmux pid=5151 outcome=unscoped reason=no-user-bus`,
      `INFO launch-session-bound launch=${LAUNCH_ID} session=sess_existing`,
    ].sort());
  });

  it('never writes scoped before the placement observation concludes', async () => {
    const capture = captureWriter();
    let conclude!: (outcome: SessionLaunchPlacementOutcome) => void;
    const log = startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'child',
      existingSessionId: '',
      pid: 4242,
      placement: new Promise((resolve) => { conclude = resolve; }),
      write: capture.write,
    });
    await settled();
    expect(capture.lines).toEqual([]);

    log.childExitedBeforeWebhook({ code: 1, signal: null });
    await settled();
    expect(capture.lines).toEqual([]);

    conclude({ outcome: 'unknown', lastCgroup: null, reason: { kind: 'pid-gone' } });
    await settled();
    expect(capture.lines).toEqual([
      `INFO launch-placement launch=${LAUNCH_ID} session=pending mode=child pid=4242 outcome=unknown last_cgroup=none reason=pid-gone`,
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=child pid=4242 code=1 signal=null webhook=not-received placement=unknown stage=unknown`,
    ]);
  });
});

describe('launch-failed is written only for a launch still pending its webhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function startChildLaunch(capture: ReturnType<typeof captureWriter>) {
    return startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'child',
      existingSessionId: '',
      pid: 4242,
      placement: Promise.resolve({ outcome: 'scoped', unitName: UNIT }),
      write: capture.write,
    });
  }

  /** The child-exit listener as startDaemon wires it: permanent, guarded by the pending resolver. */
  function childExited(
    maps: ReturnType<typeof spawnMaps>,
    log: ReturnType<typeof startChildLaunch>,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) {
    if (settlePendingSpawnBeforeWebhook({ pid: 4242, ...maps, result: childExitResult })) {
      log.childExitedBeforeWebhook({ code, signal });
    }
  }

  it('writes no launch-failed line when the session ends after a successful webhook', async () => {
    const capture = captureWriter();
    const maps = spawnMaps();
    const log = startChildLaunch(capture);
    const completion = waitForSessionWebhook({ pid: 4242, ...maps, timeoutErrorMessage: 'timeout' });

    maps.pidToAwaiter.get(4242)?.({ happySessionId: 'sess_new' } as TrackedSession);
    await expect(completion).resolves.toEqual({ type: 'success', sessionId: 'sess_new' });
    log.sessionBound('sess_new');

    // The ordinary end of the session, long after launch.
    childExited(maps, log, 0, null);
    await settled();

    // The lines correlate by launch id; their relative order is not guaranteed.
    expect([...capture.lines].sort()).toEqual([
      `INFO launch-placement launch=${LAUNCH_ID} session=pending mode=child pid=4242 outcome=scoped unit=${UNIT}`,
      `INFO launch-session-bound launch=${LAUNCH_ID} session=sess_new`,
    ].sort());
    expect(capture.lines.some((line) => line.includes('launch-failed'))).toBe(false);
  });

  it('writes launch-failed with the exit code when the runner exits before its webhook', async () => {
    const capture = captureWriter();
    const maps = spawnMaps();
    const log = startChildLaunch(capture);
    const completion = waitForSessionWebhook({ pid: 4242, ...maps, timeoutErrorMessage: 'timeout' });

    childExited(maps, log, 217, null);
    await expect(completion).resolves.toEqual(childExitResult);
    // A later duplicate exit notification finds no pending launch.
    childExited(maps, log, 217, null);
    await settled();

    expect(capture.lines.filter((line) => line.includes('launch-failed'))).toEqual([
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=child pid=4242 code=217 signal=null webhook=not-received placement=scoped stage=unknown`,
    ]);
  });

  it('writes no exit-path launch-failed after a webhook timeout; the timeout path owns that line', async () => {
    vi.useFakeTimers();
    const capture = captureWriter();
    const maps = spawnMaps();
    const log = startChildLaunch(capture);
    const completion = waitForSessionWebhook({
      pid: 4242,
      ...maps,
      timeoutMs: 1_000,
      timeoutErrorMessage: 'timeout',
      onTimeout: () => log.webhookTimedOut({ processRunning: true }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(completion).resolves.toMatchObject({ errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    childExited(maps, log, 1, null);
    vi.useRealTimers();
    await settled();

    expect(capture.lines.filter((line) => line.includes('launch-failed'))).toEqual([
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=child pid=4242 reason=webhook-timeout code=unavailable signal=unavailable process=running webhook=not-received placement=scoped stage=unknown`,
    ]);
  });

  it('writes the error-event and tmux timeout forms without claiming an exit code', async () => {
    const capture = captureWriter();
    const child = startChildLaunch(capture);
    child.childErrorBeforeWebhook(new Error('spawn systemd-run ENOENT'));
    const tmux = startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'tmux',
      existingSessionId: '',
      pid: 5151,
      placement: Promise.resolve({ outcome: 'unknown', lastCgroup: '/user.slice/user-1000.slice/session-3.scope', reason: { kind: 'bound-elapsed' } }),
      write: capture.write,
    });
    tmux.webhookTimedOut();
    await settled();

    // Two independent attempts: no order between them is promised.
    expect(capture.lines.filter((line) => line.includes('launch-failed')).sort()).toEqual([
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=child pid=4242 code=unavailable signal=unavailable message="spawn systemd-run ENOENT" webhook=not-received placement=scoped stage=unknown`,
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=tmux pid=5151 reason=webhook-timeout code=unavailable signal=unavailable webhook=not-received placement=unknown stage=unknown`,
    ].sort());
  });
});

describe('a hung placement read does not withhold the pending failure line', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes one unknown placement and one launch-failed line at the bound, and nothing when the read settles late', async () => {
    vi.useFakeTimers();
    const capture = captureWriter();
    let settleLate!: (content: string) => void;
    const placement = resolveSessionLaunchPlacement({
      intent: { kind: 'systemd-scope', launchId: LAUNCH_ID, unitName: UNIT },
      pid: 4242,
      uid: 1000,
      readProcFile: async (path) => {
        if (path.endsWith('/stat')) {
          return await new Promise<string>((resolve) => { settleLate = resolve; });
        }
        return `0::/user.slice/user-1000.slice/user@1000.service/happier.slice/happier-jobs.slice/${UNIT}\n`;
      },
    });
    const log = startSessionLaunchOutcomeLog({
      launchId: LAUNCH_ID,
      mode: 'child',
      existingSessionId: '',
      pid: 4242,
      placement,
      write: capture.write,
    });

    await vi.advanceTimersByTimeAsync(100);
    log.childExitedBeforeWebhook({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(1_800);
    expect(capture.lines).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(capture.lines).toEqual([
      `INFO launch-placement launch=${LAUNCH_ID} session=pending mode=child pid=4242 outcome=unknown last_cgroup=none reason=bound-elapsed`,
      `WARN launch-failed launch=${LAUNCH_ID} session=pending mode=child pid=4242 code=1 signal=null webhook=not-received placement=unknown stage=unknown`,
    ]);

    settleLate('4242 (node) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 777 0\n');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture.lines).toHaveLength(2);
  });
});
