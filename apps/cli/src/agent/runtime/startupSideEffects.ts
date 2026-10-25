import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import {
    isSessionStartedReadinessNotReadyErrorCode,
    SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS,
} from '@/daemon/sessionStartedReadiness';
import { writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalAttachmentId, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { buildTerminalFallbackMessage } from '@/terminal/attachment/terminalFallbackMessage';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

type DaemonReportDeps = {
    notifyDaemonSessionStartedFn?: typeof notifyDaemonSessionStarted;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
    retryTimeoutMs?: number;
    /** First retry delay (backoff base). */
    retryIntervalMs?: number;
    /** Retry delay cap; never below the base. */
    retryMaxIntervalMs?: number;
    /** Jitter source in [0, 1); injectable for tests. */
    randomFn?: () => number;
    reportAttemptTimeoutMs?: number;
    onReported?: (opts: { sessionId: string }) => Promise<void> | void;
};

type InFlightDaemonSessionReport = {
    latestMetadata: Metadata;
    revision: number;
    requireDaemonAck: boolean;
    onReportedCallbacks: Set<NonNullable<DaemonReportDeps['onReported']>>;
    promise: Promise<void>;
};

const inFlightDaemonSessionReports = new Map<string, InFlightDaemonSessionReport>();

/**
 * Per-attempt HTTP timeout for a daemon-started runner's report. It exceeds the daemon's own
 * readiness answer bound, so every attempt to a live daemon gets an answer even while the
 * daemon's server account check is slow.
 */
export const DAEMON_STARTED_REPORT_ATTEMPT_TIMEOUT_MS = SESSION_STARTED_READINESS_ANSWER_TIMEOUT_MS + 10_000;

/**
 * Hard ceiling on how long a runner that requires the daemon's readiness acknowledgement keeps
 * reporting, counted from its first attempt. It matters while the daemon keeps answering that
 * readiness has not settled (a slow server, 2026-10-23). It is a deadline: each attempt is aborted
 * when it passes, from reading the daemon state through the HTTP answer; each pause is clipped to
 * the time left; and an acknowledgement that settles after it is not accepted. A daemon that stops
 * answering still fails the runner once the ordinary retry window passes without an answer.
 */
export const DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS = 10 * 60_000;

function isTransientDaemonReportError(error: string): boolean {
    const normalized = error.trim().toLowerCase();
    if (!normalized) return false;
    return (
        normalized.includes('no daemon running') ||
        normalized.includes('daemon is not running') ||
        normalized.includes('request failed') ||
        normalized.includes('unauthorized') ||
        normalized.includes('timeout') ||
        normalized.includes('fetch failed') ||
        normalized.includes('econn') ||
        normalized.includes('network')
    );
}

function resolveDaemonReportRetryValue(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

/**
 * Retry spacing for the runner's `/session-started` report.
 *
 * After the n-th consecutive failed attempt the runner requests a sleep of nominal
 * `min(cap, base * FACTOR^(n-1))`: with the defaults 250, 500, 1000, 2000 and 4000 ms after
 * failures 1-5, and the 5 s cap from the 6th failure on. Jitter then scales the nominal value by
 * `1 - JITTER_FRACTION * random`, i.e. into [nominal / 2, nominal], and finally the sleep is clamped
 * to what remains of the retry budget, so the last sleep before the deadline can be shorter than
 * half its nominal value. Every transient failure counts, including the daemon's 503
 * `session_startup_reconciliation_failed`.
 *
 * These are requested sleeps only. Attempt count and elapsed time also depend on how long each
 * request takes and on timer scheduling. The loop (unchanged here) has no deadline check before
 * starting the next request, and each request's timeout is the full per-attempt timeout bounded by
 * the whole budget, not by the time remaining, so a late timer can start a request after the
 * deadline and a request started at the deadline can finish after it.
 *
 * - base 250 ms (`HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS`, formerly the fixed interval): a
 *   daemon that is simply not listening yet still gets answered within the first few hundred ms.
 * - factor 2: the nominal sleep doubles per failure until the cap.
 * - cap 5 s (`HAPPIER_DAEMON_REPORT_SESSION_RETRY_MAX_INTERVAL_MS`, raised to the base when lower):
 *   a 503 means the daemon's startup reconciliation failed (a relay round trip with a 15 s
 *   timeout failing is one cause; a missing generation consumer or another reconciliation error is
 *   another), so retrying more often than every few seconds mostly repeats that work. The cap
 *   bounds the requested sleep, not the time from daemon recovery to acknowledgement.
 * - jitter down to half of the nominal sleep ("equal jitter"): runners started together by one
 *   daemon spread their retries instead of arriving in waves, and apart from the budget clamp no
 *   sleep drops below half its nominal value.
 */
const DAEMON_REPORT_RETRY_BASE_MS = 250;
const DAEMON_REPORT_RETRY_FACTOR = 2;
const DAEMON_REPORT_RETRY_MAX_MS = 5_000;
const DAEMON_REPORT_RETRY_JITTER_FRACTION = 0.5;

export function resolveDaemonReportRetryDelayMs(input: Readonly<{
    consecutiveFailures: number;
    baseMs: number;
    maxMs: number;
    random: number;
}>): number {
    const cap = Math.max(input.baseMs, input.maxMs);
    const exponent = Math.min(Math.max(input.consecutiveFailures - 1, 0), 30);
    const nominal = Math.min(cap, input.baseMs * DAEMON_REPORT_RETRY_FACTOR ** exponent);
    const random = Math.min(Math.max(input.random, 0), 1);
    return Math.round(nominal * (1 - DAEMON_REPORT_RETRY_JITTER_FRACTION * random));
}

function isTruthyEnvFlag(raw: string | undefined): boolean {
    const normalized = (raw ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

export function primeAgentStateForUi(session: ApiSessionClient, logPrefix: string): void {
    // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
    // The server does not currently persist agentState during initial session creation; it starts at version 0
    // and only changes via 'update-state'. The UI uses agentStateVersion > 0 as its readiness signal.
    updateAgentStateBestEffort(
        session,
        (currentState) => ({ ...currentState }),
        logPrefix,
        'prime agent state for ui',
    );
}

export function resolveTerminalAttachmentPersistenceBinding(
    terminal: NonNullable<Metadata['terminal']>,
): Readonly<{
    attachmentId: TerminalAttachmentId;
    handle: TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;
}> | null {
    const serviceability = terminal.controlServiceabilityV1;
    const attachmentIdRaw = serviceability?.v === 1
        && serviceability.retired !== true
        && (serviceability.state === 'servable' || serviceability.state === 'recoverable_unservable')
        && typeof serviceability.attachmentId === 'string'
        ? serviceability.attachmentId.trim()
        : '';
    if (!attachmentIdRaw) return null;
    const attachmentId = attachmentIdRaw as TerminalAttachmentId;
    const handle = buildTerminalHostHandleFromAttachmentMetadata(terminal);
    if (!handle) return null;
    return {
        attachmentId,
        handle: { ...handle, attachmentId },
    };
}

export async function persistTerminalAttachmentInfoIfNeeded(opts: {
    sessionId: string;
    terminal: Metadata['terminal'] | undefined;
}): Promise<void> {
    if (!opts.terminal) return;
    const binding = resolveTerminalAttachmentPersistenceBinding(opts.terminal);
    try {
        await writeTerminalAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: opts.sessionId,
            terminal: opts.terminal,
            ...(binding ?? {}),
        });
    } catch (error) {
        logger.debug('[START] Failed to persist terminal attachment info', error);
        if (binding) throw error;
    }
}

export function sendTerminalFallbackMessageIfNeeded(opts: {
    session: ApiSessionClient;
    terminal: Metadata['terminal'] | undefined;
}): void {
    if (!opts.terminal) return;
    const fallbackMessage = buildTerminalFallbackMessage(opts.terminal);
    if (!fallbackMessage) return;
    opts.session.sendSessionEvent({ type: 'message', message: fallbackMessage });
}

async function runDaemonSessionReport(
  sessionId: string,
  state: InFlightDaemonSessionReport,
  deps: DaemonReportDeps,
): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const nowFn = deps.nowFn ?? (() => Date.now());
    const randomFn = deps.randomFn ?? Math.random;
    const retryIntervalMs =
        deps.retryIntervalMs ??
        resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS, DAEMON_REPORT_RETRY_BASE_MS, {
            min: 50,
            max: 10_000,
        });
    const retryMaxIntervalMs =
        deps.retryMaxIntervalMs ??
        resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_MAX_INTERVAL_MS, DAEMON_REPORT_RETRY_MAX_MS, {
            min: 50,
            max: 60_000,
        });

    const startedAt = nowFn();
    let lastDaemonAnswerAt: number | null = null;
    let attempt = 0;
    let consecutiveFailures = 0;
    while (true) {
        attempt += 1;
        const revision = state.revision;
        const metadata = state.latestMetadata;
        const startedBy = String(metadata?.startedBy ?? '').trim().toLowerCase();
        const daemonAutostartEnabled = isTruthyEnvFlag(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON);
        const defaultRetryTimeoutMs =
            startedBy === 'daemon'
                ? 90_000
                : daemonAutostartEnabled
                    ? 30_000
                    : 10_000;
        const retryTimeoutMs =
            deps.retryTimeoutMs ??
            resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS, defaultRetryTimeoutMs, {
                min: 0,
                max: 120_000,
            });
        const defaultReportAttemptTimeoutMs = startedBy === 'daemon' ? DAEMON_STARTED_REPORT_ATTEMPT_TIMEOUT_MS : 2_500;
        const reportAttemptTimeoutMs =
            deps.reportAttemptTimeoutMs ??
            resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS, defaultReportAttemptTimeoutMs, {
                min: 100,
                max: 30_000,
            });
        // A runner that needs the acknowledgement never reports past the ceiling, whatever the answers.
        const remainingCeilingMs = (): number => state.requireDaemonAck
            ? startedAt + DAEMON_READINESS_ANSWERED_WAIT_CEILING_MS - nowFn()
            : Number.POSITIVE_INFINITY;
        const remainingAtAttemptMs = remainingCeilingMs();
        if (remainingAtAttemptMs <= 0) break;
        const boundedAttemptTimeoutMs = Math.min(
            reportAttemptTimeoutMs,
            Math.max(100, retryTimeoutMs),
            remainingAtAttemptMs,
        );
        // While a live daemon keeps answering that readiness is not settled, a runner that needs its
        // acknowledgement keeps waiting until the ceiling; otherwise the retry window counts from the start.
        const isRetryWindowExhausted = (): boolean => {
            const now = nowFn();
            if (remainingCeilingMs() <= 0) return true;
            if (state.requireDaemonAck && lastDaemonAnswerAt !== null) {
                return now - lastDaemonAnswerAt >= retryTimeoutMs;
            }
            return now - startedAt >= retryTimeoutMs;
        };
        const pauseBeforeNextAttempt = async (): Promise<void> => {
            consecutiveFailures += 1;
            const delayMs = resolveDaemonReportRetryDelayMs({
                consecutiveFailures,
                baseMs: retryIntervalMs,
                maxMs: retryMaxIntervalMs,
                random: randomFn(),
            });
            // Use the same window as the exhaustion guard: a live readiness answer moves its
            // origin, while an unanswered daemon keeps the original budget. Both obey the ceiling.
            const windowStartedAt = state.requireDaemonAck && lastDaemonAnswerAt !== null
                ? lastDaemonAnswerAt
                : startedAt;
            const remainingBudgetMs = Math.max(0, retryTimeoutMs - (nowFn() - windowStartedAt));
            await sleepFn(Math.min(delayMs, remainingBudgetMs, Math.max(0, remainingCeilingMs())));
        };

        // The control client floors an explicit timeout at 100 ms and reads the daemon state before
        // the request, so the ceiling reaches it as an abort signal covering the whole attempt.
        const ceilingAbort = Number.isFinite(remainingAtAttemptMs) ? new AbortController() : null;
        const ceilingTimer = ceilingAbort
            ? setTimeout(() => ceilingAbort.abort(new Error('daemon readiness acknowledgement ceiling timeout')), remainingAtAttemptMs)
            : null;
        try {
            logger.debug(`[START] Reporting session ${sessionId} to daemon (attempt ${attempt})`);
            const result = await notifyFn(
                sessionId,
                metadata,
                {
                    timeoutMs: boundedAttemptTimeoutMs,
                    ...(ceilingAbort ? { signal: ceilingAbort.signal } : {}),
                },
            );
            if (!result?.error) {
                // An acknowledgement that settles after the ceiling is not accepted.
                if (remainingCeilingMs() <= 0) break;
                if (state.revision !== revision) continue;
                logger.debug(`[START] Reported session ${sessionId} to daemon`);
                for (const onReported of state.onReportedCallbacks) {
                    try {
                        await onReported({ sessionId });
                    } catch (error) {
                        logger.debug('[START] Failed to run daemon session-reported callback', error);
                    }
                }
                return;
            }

            const message = String(result.error);
            if (isSessionStartedReadinessNotReadyErrorCode(result.errorCode)) {
                lastDaemonAnswerAt = nowFn();
                logger.debug(`[START] Daemon answered that session ${sessionId} readiness has not settled (${result.errorCode})`);
            }
            if (!isTransientDaemonReportError(message) || isRetryWindowExhausted()) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
                if (state.requireDaemonAck) {
                    throw new Error('Claude runtime readiness was not acknowledged by the daemon');
                }
                return;
            }
            await pauseBeforeNextAttempt();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            if (!isTransientDaemonReportError(message) || isRetryWindowExhausted()) {
                logger.debug('[START] Failed to report to daemon (may not be running):', error);
                if (state.requireDaemonAck) {
                    throw new Error('Claude runtime readiness was not acknowledged by the daemon');
                }
                return;
            }
            await pauseBeforeNextAttempt();
        } finally {
            if (ceilingTimer) clearTimeout(ceilingTimer);
        }
    }
    logger.debug(`[START] Daemon readiness for session ${sessionId} not acknowledged within the ceiling`);
    throw new Error('Claude runtime readiness was not acknowledged by the daemon');
}

export function reportSessionToDaemonIfRunning(opts: {
    sessionId: string;
    metadata: Metadata;
    requireDaemonAck?: boolean;
}, deps: DaemonReportDeps = {}): Promise<void> {
    const sessionId = opts.sessionId.trim();
    const existing = inFlightDaemonSessionReports.get(sessionId);
    if (existing) {
        existing.latestMetadata = opts.metadata;
        existing.revision += 1;
        existing.requireDaemonAck ||= opts.requireDaemonAck === true;
        if (deps.onReported) existing.onReportedCallbacks.add(deps.onReported);
        return existing.promise;
    }

    const state: InFlightDaemonSessionReport = {
        latestMetadata: opts.metadata,
        revision: 0,
        requireDaemonAck: opts.requireDaemonAck === true,
        onReportedCallbacks: new Set(deps.onReported ? [deps.onReported] : []),
        promise: Promise.resolve(),
    };
    inFlightDaemonSessionReports.set(sessionId, state);
    state.promise = runDaemonSessionReport(sessionId, state, deps).finally(() => {
        if (inFlightDaemonSessionReports.get(sessionId) === state) {
            inFlightDaemonSessionReports.delete(sessionId);
        }
    });
    return state.promise;
}
