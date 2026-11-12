import { readPendingLocalId, type SessionPendingInputInterruptAndRunResultV1 } from '@happier-dev/protocol';

import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { PendingInputSteerNowAdmission, SessionClientPort } from '@/api/session/sessionClientPort';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { logger } from '@/ui/logger';

import type { PendingInterruptAndSendEvidence } from './claudeRemoteAgentSdk';

export type { PendingInterruptAndSendEvidence };

/**
 * Which exact pending rows the SDK runner actually interrupted an active turn for. The runner reports
 * facts (`onPendingInterruptAndSendEvidence`) in whatever order they happen; a row interrupted its turn
 * only when that turn's result proved the requested abort and the row's own interrupt was not refused.
 * The claim is read when the row's outcome is reported, never fixed earlier. A request watches its own
 * row only while it runs.
 */
export type ClaudeAgentSdkInterruptObservations = Readonly<{
    recordEvidence: (userMessageLocalIds: readonly string[], evidence: PendingInterruptAndSendEvidence) => void;
    watch: (localId: string) => Readonly<{ interruptPerformed: () => boolean; stop: () => void }>;
}>;

export function createClaudeAgentSdkInterruptObservations(): ClaudeAgentSdkInterruptObservations {
    const watched = new Map<string, Set<PendingInterruptAndSendEvidence>>();
    return Object.freeze({
        recordEvidence(userMessageLocalIds, evidence) {
            // Same exactness as provider input outcomes: one row per provider prompt.
            const localId = userMessageLocalIds.length === 1 ? readPendingLocalId(userMessageLocalIds[0]) : null;
            if (localId !== null) watched.get(localId)?.add(evidence);
        },
        watch(localId) {
            const evidence = new Set<PendingInterruptAndSendEvidence>();
            watched.set(localId, evidence);
            return {
                interruptPerformed: () => evidence.has('target_interrupted') && !evidence.has('interrupt_refused'),
                stop: () => { if (watched.get(localId) === evidence) watched.delete(localId); },
            };
        },
    });
}

/**
 * `session.pendingInput.interruptAndRun` for the Claude Agent SDK runner.
 *
 * The SDK runner already owns the effect: a Pending row materialized with provider action
 * `interrupt_and_send` interrupts the active SDK turn and becomes its very next input
 * (`claudeRemoteAgentSdk`) without waiting for the interrupt's answer. An interrupt that throws before
 * writing any request rejects that row before any effect; one the provider refuses leaves the row
 * queued until the turn's boundary. This control
 * only selects the exact row: it persists `send_now` on that localId (the server turns it into
 * `interrupt_and_send` while the foreground turn is busy), drains the exact localId, and reports the
 * provider's terminal outcome for it. It never runs another queued input, never re-sends a row the
 * client already holds custody of, and reports an unobserved delivery as such.
 *
 * Acceptance alone does not mean a turn was interrupted: when the turn ends between the check and
 * the PATCH, the server materializes a plain send and the row simply runs at the turn boundary.
 * `interrupted` is reported only when the runner observed interrupting an active turn for this row.
 * This runner publishes no state stamp for its rows, so a request naming `expectedStateAtMs` is
 * refused before any effect rather than run against an unverified state.
 */
export function createClaudeAgentSdkPendingInputInterruptAndRunControl(opts: Readonly<{
    session: Readonly<{ sessionId: string }>
        & Required<Pick<SessionClientPort, 'requestPendingInputSendNow' | 'waitForProviderInputTerminalOutcome'>>;
    inputConsumer: Pick<SessionProviderInputConsumer<unknown, unknown>, 'drainPending'>;
    /** This runner is the session's live SDK runner and still admits provider input. */
    isRunnerLive: () => boolean;
    /** A foreground SDK turn is running (there is something to interrupt). */
    isTurnActive: () => boolean;
    interrupts: Pick<ClaudeAgentSdkInterruptObservations, 'watch'>;
    outcomeTimeoutMs?: number;
}>): NonNullable<SessionRuntimeControls['interruptPendingInputAndRun']> {
    const inFlight = new Set<string>();
    return async (request) => {
        const identity = { sessionId: request.sessionId, localId: request.localId };
        if (request.sessionId !== opts.session.sessionId || !opts.isRunnerLive()) {
            return { ok: false, status: 'stale_state', ...identity };
        }
        if (request.expectedStateAtMs !== undefined) {
            return {
                ok: false,
                status: 'not_safe',
                ...identity,
                errorCode: 'expected_state_unverifiable',
                error: 'The Claude Agent SDK runner publishes no state for this pending input to check expectedStateAtMs against',
            };
        }
        if (!opts.isTurnActive()) {
            return {
                ok: false,
                status: 'not_safe',
                ...identity,
                errorCode: 'no_active_turn',
                error: 'No Claude turn is running; the pending input runs in its normal queue order',
            };
        }
        if (inFlight.has(request.localId)) {
            return {
                ok: false,
                status: 'not_safe',
                ...identity,
                errorCode: 'interrupt_and_run_in_flight',
                error: 'This pending input already has an interrupt-and-run request in flight',
            };
        }
        inFlight.add(request.localId);
        const interrupt = opts.interrupts.watch(request.localId);
        // Observe the outcome before the PATCH: its Pending wake can arrive before the HTTP ack.
        const outcomeController = new AbortController();
        const outcomePromise = opts.session.waitForProviderInputTerminalOutcome(
            request.localId, opts.outcomeTimeoutMs ?? 10_000, outcomeController.signal);
        let admission: PendingInputSteerNowAdmission = { kind: 'admission_uncertain' };
        const unobserved = (): SessionPendingInputInterruptAndRunResultV1 => admission.kind === 'admitted'
            ? { ok: true, status: 'admitted_delivery_unobserved', ...identity }
            : {
                ok: false,
                status: 'interrupt_failed',
                ...identity,
                errorCode: 'pending_input_send_now_admission_uncertain',
                error: 'The exact pending input may have been marked to run now; its delivery has not been observed',
            };
        try {
            admission = await opts.session.requestPendingInputSendNow(request.localId);
            if (admission.kind === 'not_admitted') {
                return {
                    ok: false,
                    status: admission.reason === 'invalid_local_id' ? 'stale_state' : 'interrupt_failed',
                    ...identity,
                    errorCode: 'pending_input_send_now_unavailable',
                    error: 'The exact pending input could not be marked to run now',
                };
            }
            await opts.inputConsumer.drainPending({
                requestedLocalId: request.localId,
                reason: 'interrupt_pending_input_and_run',
            });
            const outcome = await outcomePromise;
            if (outcome.kind === 'accepted') {
                return interrupt.interruptPerformed()
                    ? { ok: true, status: 'interrupted', ...identity }
                    : { ok: true, status: 'admitted_and_queued_until_boundary', ...identity };
            }
            if (outcome.kind === 'rejected_before_effect') {
                return {
                    ok: false,
                    status: 'interrupt_failed',
                    ...identity,
                    errorCode: outcome.reason ?? 'provider_rejected_before_acceptance',
                    error: 'The Claude runner rejected the exact pending input before running it',
                };
            }
            return unobserved();
        } catch (error) {
            logger.debug('[Claude SDK] exact pending input interrupt-and-run delivery was not observed', {
                localId: request.localId,
                errorName: error instanceof Error ? error.name : typeof error,
            });
            return unobserved();
        } finally {
            outcomeController.abort();
            interrupt.stop();
            inFlight.delete(request.localId);
        }
    };
}
