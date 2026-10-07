import { setupReplacesValidatedAccount } from '@happier-dev/protocol';

import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';

import {
    daemonRelayMatchesExpectation,
    resolveThisComputerService,
    type DesktopLocalInspection,
    type DesktopLocalReadinessFacts,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';

/**
 * `start`: run the executor now. `confirm_relay`: ask before the app moves this computer's
 * background service to another Relay (UD5). `confirm_account`: ask before the app moves it to
 * another ACCOUNT (D1) — always asked, and never covered by the relay-only "always move".
 */
export type RelayReconciliationDecision = 'start' | 'confirm_relay' | 'confirm_account' | 'leave_user_service';

export type RelayReconciliationInput = Readonly<{
    /** The one ambient inspection (plan §3.3) — immutable for this app open. */
    inspection: DesktopLocalInspection;
    /** The relay and account the app expected when those facts were read. */
    observedExpectation: DesktopSetupExpectation | null;
    /** Where the executor would take this computer: the relay and account the app is on NOW. */
    target: DesktopSetupExpectation;
    /** The device-local "always move my default-following service with my selected default relay". */
    alwaysMoveDefaultFollowingService: boolean;
}>;

/**
 * D1 — the relay validated this daemon for an account, and it is not the one the app is on now.
 *
 * It is a fact about the daemon, not about who installed it: a CLI signed in from a terminal with
 * no service of the app's, a manual daemon, and the app's own service all lose their account the
 * same way when the executor claims this computer with `--replace-existing`. It is measured
 * against the CURRENT target, never the identity the app first observed — signing out of A and
 * into C in one run leaves the observation saying A, exactly like the daemon.
 */
function daemonAccountContradictsTarget(facts: DesktopLocalReadinessFacts, target: DesktopSetupExpectation): boolean {
    // The same rule the executor enforces on the credentials it would replace.
    return setupReplacesValidatedAccount({ validatedAccountId: facts.auth.validatedAccountId, expectedAccountId: target.accountId });
}

/**
 * UD5 + D1, decided from current facts only — never installation history (D7).
 *
 * An **account** move is asked first and always (D1): whatever service runs here, the account it
 * is signed in as stops reaching this computer, and "always move" was only ever an answer about
 * relays.
 *
 * A **relay** move is silent only when the facts prove the service is the app's own and is where
 * the app last put it:
 *
 * - **that is default-following** — `service.targetMode` says so, and it is asked of every
 *   installed service before anything else, running or stopped. That is the only mode whose
 *   contract is "track the selected default relay". A `pinned` service was deliberately fixed to
 *   one relay, and `null` means nothing proved a mode at all (an older CLI, or an unreadable
 *   definition); neither is evidence the app may move it, so both are asked about. This fact is
 *   required because the rest of the picture cannot supply it: an installed service whose running
 *   daemon its own installation owns looks identical whether it is pinned or following, so without
 *   the mode a remembered "always move my default-following service" could repoint a pinned one;
 * - **on the relay the app last expected**, compared through the corridor's one relay comparer;
 * - **with credentials the relay validated** — an unvalidated daemon proves nothing about where
 *   it belongs.
 *
 * A daemon already on the target relay, with no account contradiction, moves nowhere: the
 * executor converges it and the CLI's own dry-run raises any ownership consent (INV9).
 *
 * A manual, foreign-home, conflicting or multiple service is one this installation does not own at
 * all, so this function does not classify it: the executor's `service install --dry-run --json`
 * does, and raises the CLI's own consent (INV9). Restating that ownership policy here would put a
 * second, weaker decision in the UI.
 */
export function resolveRelayReconciliationConsent(input: RelayReconciliationInput): RelayReconciliationDecision {
    // R12-F1 — the relay's own service here could not be read: nothing is moved or converged on a
    // guess; the question is asked and bootstrap refuses to fall through to the default service.
    if (input.inspection.status === 'resolved' && resolveThisComputerService(input.inspection, input.target) === null) {
        return 'confirm_relay';
    }
    // One daemon per relay: the relay already has its own pinned service here, so nothing moves.
    // That service still answers for an account, and D1 holds for it exactly as for any other.
    const pinned = pinnedServiceServing(input.inspection, input.target);
    if (pinned) {
        // H2 — a relay service the user set up is theirs: the app shows it, never converges it.
        if (pinned.service.managedBy !== 'desktop') {
            return 'leave_user_service';
        }
        return daemonAccountContradictsTarget(pinned, input.target) ? 'confirm_account' : 'start';
    }
    if (input.inspection.status === 'resolved' && daemonAccountContradictsTarget(input.inspection.facts, input.target)) {
        return 'confirm_account';
    }
    if (input.inspection.status !== 'resolved' || !input.observedExpectation) {
        return 'confirm_relay';
    }
    const facts = input.inspection.facts;
    if (facts.runtimeConvergence !== null && daemonRelayMatchesExpectation(facts, input.target)) {
        // Already on the relay the app is going to, as no other account: nothing moves.
        return 'start';
    }
    // UD5 turns on what this service IS, not on whether it happens to be running. Only a
    // default-following service is the app's to move with its selected default relay; `pinned` and
    // UNKNOWN are asked about, and neither may be reached past by the device preference. This
    // comes first because a stopped service has no running daemon for anything to own: asking
    // about ownership before the mode read every stopped definition — a pinned one included — as
    // "not the app's at all". Stopping is not consent.
    if (facts.service.installed && facts.service.targetMode !== 'default-following') {
        return 'confirm_relay';
    }
    if (!installationOwnsService(facts)) {
        // Nothing of this installation's to move: no service at all, or a bare process it does not
        // own. A first install is not a relay move, and a service this installation does not own
        // is classified by the executor's own `service install --dry-run --json` (INV9) rather
        // than asked about twice here.
        return facts.runtimeConvergence === null ? 'confirm_relay' : 'start';
    }
    if (facts.runtimeConvergence === null) {
        // The CLI that answered described no running daemon at all, so nothing below can be
        // compared honestly. Fail closed.
        return 'confirm_relay';
    }

    // N1 — this is the app's own service, on another relay: converging it takes this computer OFF
    // the relay it serves. That is always asked (Move / Connect … too / Keep) — the person may want
    // both relays — unless they chose "Always move". Nothing is taken off a served relay silently,
    // however the app got here (a direct pick, sign-in after adding a relay, a relaunch).
    //
    // N5 — and never on the preference either while a relay service here could not be read: the
    // target may already have its own, and moving the default-following one onto it would run two
    // daemons for one relay.
    if (inspectionIsIncomplete(input.inspection)) {
        return 'confirm_relay';
    }
    return input.alwaysMoveDefaultFollowingService ? 'start' : 'confirm_relay';
}

/** M6 — the executor could not read every pinned service here, so "this relay has none" is unknown. */
function inspectionIsIncomplete(inspection: DesktopLocalInspection): boolean {
    return inspection.status === 'resolved' && inspection.pinnedServicesComplete !== true;
}

/** The facts of the pinned service that serves `target` here, if the relay has its own. */
function pinnedServiceServing(inspection: DesktopLocalInspection, target: DesktopSetupExpectation): DesktopLocalReadinessFacts | null {
    if (inspection.status !== 'resolved') {
        return null;
    }
    const service = resolveThisComputerService(inspection, target);
    return service?.serviceTargetMode === 'pinned' ? service.facts : null;
}

/**
 * Whether the move question may also offer "Connect to {relay} too": give the app's relay its own
 * pinned service and leave the daemon that serves another relay where it is.
 *
 * Only when the CLI that answered says it can run a relay's own service beside the default one
 * (`pinnedServiceCoexistence`): an older one would silently run the request as a move, so it never
 * gets it (fail closed). And only when there is
 * something to keep: the default-following service is installed and serves ANOTHER relay, and this
 * relay has no service of its own yet.
 */
export function thisComputerCanConnectToo(input: Readonly<{
    inspection: DesktopLocalInspection;
    target: DesktopSetupExpectation;
}>): boolean {
    const inspection = input.inspection;
    // Offered only when this CLI can add a relay's own service beside the default one (B-03), and
    // the executor reported this computer's pinned services completely (M6): an unreadable one may
    // already serve this relay, and "none here" must never be a guess.
    if (inspection.status !== 'resolved'
        || inspection.pinnedServiceCoexistence !== true
        || !Array.isArray(inspection.pinnedServices)
        || inspection.pinnedServicesComplete !== true) {
        return false;
    }
    const facts = inspection.facts;
    return facts.service.installed
        && facts.server.serverUrl !== null
        && !daemonRelayMatchesExpectation(facts, input.target)
        && pinnedServiceServing(inspection, input.target) === null;
}

/**
 * The ONE question "is this background service this installation's to move?", asked the same way
 * by the UD5 consent decision and by the gate's relaunch discriminator below.
 *
 * Ownership is deliberately generous and deliberately independent of whether a daemon is running:
 * a running daemon its own installation owns proves it, and so does an installed definition whose
 * target mode the CLI could read. A service that is merely stopped — which is exactly where the
 * app-close guard leaves an on-demand one — is still the user's. Two predicates for this concept
 * lived in this file and disagreed: the gate routed a stopped service to reconciliation because its
 * mode was known, and reconciliation then started without asking because nothing was running for
 * it, repointing a service nobody was asked about.
 */
function installationOwnsService(facts: DesktopLocalReadinessFacts): boolean {
    return facts.service.installed
        && (facts.runtimeConvergence?.serviceOwnsRunningDaemon === true || facts.service.targetMode !== null);
}

/**
 * B2/UD5/D1 — whether the facts describe a daemon the executor would MOVE to reach the app's
 * current target, rather than converge for the first time.
 *
 * The gate's other discriminator — the relay the app expected when the facts were read — cannot
 * answer this after a relaunch: an ambient device-scope switch is persisted, so on the next open
 * the app's expectation and its current identity agree while the daemon is still somewhere else.
 * Asked of the facts instead, the question has the same answer whether it is asked in the same run
 * or a week later, which is what keeps a relaunch from silently repointing someone's daemon.
 *
 * Two kinds of move qualify:
 * - **an account move**, whoever set the daemon up (D1/U3): a CLI signed in from a terminal as
 *   another account loses this computer to `--replace-existing` just as the app's own service does;
 * - **a relay move of this installation's own service** — a running daemon its own installation
 *   owns, or an installed definition whose target mode the CLI could read. A service that is merely
 *   stopped is still the user's. Nothing installed contradicts no relay: a first install is not a
 *   move.
 *
 * The consent decision itself stays with `resolveRelayReconciliationConsent`, which this function
 * never second-guesses.
 */
export function daemonContradictsTarget(input: Readonly<{
    inspection: DesktopLocalInspection;
    target: DesktopSetupExpectation;
}>): boolean {
    if (input.inspection.status !== 'resolved') {
        return false;
    }
    // A relay with its own pinned service here is not a move; only its account can contradict.
    const pinned = pinnedServiceServing(input.inspection, input.target);
    if (pinned) {
        return daemonAccountContradictsTarget(pinned, input.target);
    }
    if (daemonAccountContradictsTarget(input.inspection.facts, input.target)) {
        return true;
    }
    return daemonMovesToAnotherRelay(input);
}

/**
 * The relay half of `daemonContradictsTarget`: this installation's own service is on a relay other
 * than the target, so converging it MOVES this computer there. It is also what the setup surface
 * names a run for ("Moving this computer to …"), so the title and the trigger cannot disagree
 * about what a move is. A first install is not a move.
 */
export function daemonMovesToAnotherRelay(input: Readonly<{
    inspection: DesktopLocalInspection;
    target: DesktopSetupExpectation;
}>): boolean {
    return input.inspection.status === 'resolved'
        && pinnedServiceServing(input.inspection, input.target) === null
        && installationOwnsService(input.inspection.facts)
        && !daemonRelayMatchesExpectation(input.inspection.facts, input.target);
}

/**
 * D5 — the daemon a person chose to keep as it is: the relay it is on and the account it is signed
 * in as. That pair is what "Keep it as is" was an answer about, so a daemon that later moves, or
 * signs in as someone else, is a new question.
 */
export type KeptBackgroundServiceIdentity = Readonly<{ relayKey: string; accountId: string | null }>;

export function identifyKeptBackgroundService(inspection: DesktopLocalInspection): KeptBackgroundServiceIdentity | null {
    if (inspection.status !== 'resolved') {
        return null;
    }
    const facts = inspection.facts;
    const relayKey = facts.server.comparableKey ?? createRelayUrlComparableKeySafe(facts.server.serverUrl);
    return relayKey ? { relayKey, accountId: facts.auth.validatedAccountId } : null;
}

/**
 * Whether this device already answered "Keep it as is" for the daemon these facts describe, and it
 * still contradicts where the app is. A daemon that is already the app's has nothing to keep.
 */
export function keptBackgroundServiceApplies(input: Readonly<{
    inspection: DesktopLocalInspection;
    target: DesktopSetupExpectation;
    kept: KeptBackgroundServiceIdentity | null;
}>): boolean {
    if (!input.kept || !daemonContradictsTarget(input)) {
        return false;
    }
    const current = identifyKeptBackgroundService(input.inspection);
    return current !== null && current.relayKey === input.kept.relayKey && current.accountId === input.kept.accountId;
}
