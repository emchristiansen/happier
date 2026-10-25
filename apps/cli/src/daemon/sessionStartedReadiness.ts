/**
 * Runner/daemon contract for `POST /session-started` while startup readiness settles.
 *
 * A daemon-started runner's readiness waits on the daemon's server account check
 * (GET /v1/account/profile, 15 s request timeout). The daemon holds a readiness answer for
 * at most this long, then answers 503 `session_startup_reconciliation_pending`; the runner's
 * next attempt joins the same check instead of starting another. The bound exceeds the
 * account-profile timeout so a check that fails on its own still reports that failure.
 */
export const SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS = 20_000;

/** 503 error codes with which a live daemon answers that the runner's readiness has not settled yet. */
export const SESSION_STARTED_READINESS_NOT_READY_ERROR_CODES = [
    'session_startup_reconciliation_failed',
    'session_startup_reconciliation_pending',
] as const;

export type SessionStartedReadinessNotReadyErrorCode = (typeof SESSION_STARTED_READINESS_NOT_READY_ERROR_CODES)[number];

export function isSessionStartedReadinessNotReadyErrorCode(value: unknown): value is SessionStartedReadinessNotReadyErrorCode {
    return SESSION_STARTED_READINESS_NOT_READY_ERROR_CODES.some((code) => code === value);
}

/** What a runner's `/session-started` report says about the runner itself, beyond session metadata. */
export type SessionStartedRunnerReport = Readonly<{
    /** The reporting runner's publisher incarnation; absent from runners that predate it. */
    publisherIncarnationId?: string;
}>;
