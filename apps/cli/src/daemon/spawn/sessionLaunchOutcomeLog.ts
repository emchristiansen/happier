import type { SessionLaunchId } from '@/daemon/platform/linux/sessionLaunchId';
import type { SessionLaunchPlacementOutcome } from '@/daemon/platform/linux/observeSessionLaunchPlacement';
import type { SystemdUserSliceProbeFailure } from '@/daemon/platform/linux/systemdUserResourceGovernor';

export type SessionLaunchMode = 'child' | 'tmux';

export type SessionLaunchOutcomeLogWriter = Readonly<{
  info: (line: string) => void;
  warn: (line: string) => void;
}>;

/** Bare when unambiguous in a `key=value` line, JSON-quoted otherwise. */
function formatLogValue(value: string): string {
  return /^[^\s"=]+$/u.test(value) ? value : JSON.stringify(value);
}

function formatProbeFailure(probe: SystemdUserSliceProbeFailure): string {
  switch (probe.kind) {
    case 'unsupported-platform':
      return `reason=unsupported-platform platform=${formatLogValue(probe.platform)}`;
    case 'no-user-bus':
      return 'reason=no-user-bus';
    case 'slice-mismatch':
      return `reason=slice-mismatch property=${formatLogValue(probe.property)} expected=${formatLogValue(probe.expected)} actual=${formatLogValue(probe.actual)}`;
    case 'probe-error':
      return `reason=probe-error message=${formatLogValue(probe.message)}`;
    case 'probe-timeout':
      return 'reason=probe-timeout';
  }
}

export function formatSessionLaunchPlacementOutcome(outcome: SessionLaunchPlacementOutcome): string {
  switch (outcome.outcome) {
    case 'scoped':
      return `outcome=scoped unit=${formatLogValue(outcome.unitName)}`;
    case 'unscoped':
      return `outcome=unscoped ${formatProbeFailure(outcome.probe)}`;
    case 'unknown': {
      const lastCgroup = outcome.lastCgroup === null ? 'none' : formatLogValue(outcome.lastCgroup);
      const reason = outcome.reason.kind === 'read-error'
        ? `read-error message=${formatLogValue(outcome.reason.message)}`
        : outcome.reason.kind;
      return `outcome=unknown last_cgroup=${lastCgroup} reason=${reason}`;
    }
  }
}

export type SessionLaunchOutcomeLog = Readonly<{
  /** Resolves once the attempt's single `launch-placement` line has been written. */
  placement: Promise<SessionLaunchPlacementOutcome>;
  /** The runner exited while its launch was still pending (no webhook yet). */
  childExitedBeforeWebhook: (params: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
  /** The ChildProcess emitted `error` while its launch was still pending. */
  childErrorBeforeWebhook: (error: unknown) => void;
  /** The webhook wait elapsed. `processRunning` is what the caller observed, when it can observe it. */
  webhookTimedOut: (params?: Readonly<{ processRunning?: boolean }>) => void;
  /** The session webhook resolved with a Session ID. */
  sessionBound: (sessionId: string) => void;
}>;

/**
 * Launch-outcome lines for one physical launch attempt, keyed by its `launchId`.
 *
 * Exactly one `launch-placement` line is written per attempt, and it is never
 * `scoped` without the observation. `launch-failed` is written only by the callers
 * that hold a pending launch (the pre-webhook resolver branch, or the webhook
 * timeout), so a session that launched and later ended is never a failed launch.
 * The stage is always `unknown`: a systemd-run exit before exec and a runner exit
 * before its webhook share one PID and can share one exit code.
 *
 * Lines correlate by `launchId`; no order between them is promised. In particular
 * `launch-session-bound` is written when the webhook resolves, which can precede the
 * placement line (written when the up-to-2 s observation concludes) and, after a
 * timeout that a tracked canonical Session ID later recovers, the timeout line too.
 * The one dependency is that `launch-failed` reports the attempt's concluded
 * placement, so it is written after that attempt's `launch-placement` line.
 *
 * Coverage is best-effort. Nothing here refuses, retries or delays a spawn.
 */
export function startSessionLaunchOutcomeLog(params: Readonly<{
  launchId: SessionLaunchId;
  mode: SessionLaunchMode;
  /** Known only when the attempt resumes an existing session; never a nonce. */
  existingSessionId: string;
  pid: number;
  placement: Promise<SessionLaunchPlacementOutcome>;
  write: SessionLaunchOutcomeLogWriter;
}>): SessionLaunchOutcomeLog {
  const sessionAtLaunch = params.existingSessionId.trim() ? formatLogValue(params.existingSessionId.trim()) : 'pending';
  const prefix = `launch=${params.launchId} session=${sessionAtLaunch} mode=${params.mode} pid=${params.pid}`;

  const placement = params.placement.then(
    (outcome) => outcome,
    (error: unknown): SessionLaunchPlacementOutcome => ({
      outcome: 'unknown',
      lastCgroup: null,
      reason: { kind: 'read-error', message: error instanceof Error ? error.message : String(error) },
    }),
  ).then((outcome) => {
    params.write.info(`launch-placement ${prefix} ${formatSessionLaunchPlacementOutcome(outcome)}`);
    return outcome;
  });

  const writeFailedAfterPlacement = (fields: string) => {
    void placement.then((outcome) => {
      params.write.warn(`launch-failed ${prefix} ${fields} webhook=not-received placement=${outcome.outcome} stage=unknown`);
    });
  };

  return {
    placement,
    childExitedBeforeWebhook: ({ code, signal }) => {
      writeFailedAfterPlacement(`code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    },
    childErrorBeforeWebhook: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      writeFailedAfterPlacement(`code=unavailable signal=unavailable message=${formatLogValue(message)}`);
    },
    webhookTimedOut: (timeout) => {
      const processState = timeout?.processRunning === undefined
        ? ''
        : ` process=${timeout.processRunning ? 'running' : 'exited'}`;
      writeFailedAfterPlacement(`reason=webhook-timeout code=unavailable signal=unavailable${processState}`);
    },
    sessionBound: (sessionId) => {
      params.write.info(`launch-session-bound launch=${params.launchId} session=${formatLogValue(sessionId)}`);
    },
  };
}
