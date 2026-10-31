import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';

/**
 * Whether the installed background service starts the daemon at login — the CLI's own
 * `at-login | on-demand` vocabulary, carried unchanged from `happier daemon status --json`
 * through the toggle that writes it back. One name for one concept, so nothing in between has to
 * translate; `null` is UNKNOWN and is never one of the modes.
 */
export type DesktopBackgroundServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * The ambient facts `daemon.service.status.v1` reports about this computer. They describe the
 * CLI that answered, its configured relay, its validated credentials, the installed service and
 * — through `runtimeConvergence` — the daemon that is actually running (plan INV8). They never
 * include an account-wide machine count (A4) and are never target-scoped (D3).
 */
export type DesktopLocalReadinessFacts = Readonly<{
    acquisition: Readonly<{
        command: string;
        provenance: 'managed' | 'override';
        /** The version that CLI reports for itself; `null` when the answer carried none. */
        version: string | null;
        /**
         * The release channel whose managed CLI this is — the default channel's when the app adopted
         * it (D2), else the app's own. `null` for an override CLI, or when the answer carried none.
         */
        channel: DesktopCliChannel | null;
    }>;
    server: Readonly<{
        serverUrl: string | null;
        publicServerUrl: string | null;
        localServerUrl: string | null;
        comparableKey: string | null;
    }>;
    auth: Readonly<{
        credentialState: 'missing' | 'rejected' | 'valid' | 'unknown' | null;
        /** The account the relay confirmed the CLI credentials belong to; null unless `credentialState` is `valid`. */
        validatedAccountId: string | null;
        /** The account named by the credentials on disk. Diagnostic; never sufficient for readiness. */
        accountId: string | null;
        /**
         * K1 — a readable label for the validated account (the relay profile's username, else its
         * display name). `null` when the CLI reports none; readers fall back to a short id.
         */
        accountLabel: string | null;
        machineId: string | null;
    }>;
    service: Readonly<{
        installed: boolean;
        running: boolean;
        /**
         * The autostart mode the installed definition declares. `null` when the CLI that answered
         * does not report one. The desktop settings toggle and the app-close guard project it;
         * entry policy does not — a stopped service the app owns gets the same quiet start
         * whichever way it starts at login (H6/D6).
         */
        autostart: DesktopBackgroundServiceAutostartMode | null;
        /**
         * What the installed service's own definition says it follows. `default-following` is the
         * mode whose contract is "track the selected default relay"; `pinned` was deliberately
         * fixed to one relay. **`null` means UNKNOWN** — an older CLI that reports no mode, or a
         * definition that proved none — and readers fail closed on it (UD5). It is never a
         * default and never evidence that this service is the app's to move.
         */
        targetMode: 'default-following' | 'pinned' | null;
        /**
         * H2 — who manages a pinned service: `desktop` when this app installed it ("connect to this
         * relay too"), `null` when the user set it up. Only a desktop-managed service is ever
         * started, stopped or rewritten by the app. Absent for the default-following service,
         * which the app manages as this computer's one default (D2).
         */
        managedBy?: 'desktop' | null;
    }>;
    runtimeConvergence: Readonly<{
        controlReachable: boolean;
        serviceOwnsRunningDaemon: boolean;
        machineIdMatches: boolean;
        cliVersionMatches: boolean;
    }> | null;
    /**
     * K1/R17 — the CLI's own update check for the app's release channel, from its cached answer.
     * `managed` says whether the app's install path placed this CLI, i.e. whether the app may
     * update it. `null` when the CLI reports none (an older CLI, or no check has answered yet).
     */
    cliUpdate: DesktopCliUpdateFacts | null;
    /** R12 — this computer's one-CLI answer and the CLI that is not the managed one. */
    cliChoice: DesktopCliChoiceFacts;
}>;

/**
 * R12 — `mode` is what this computer answered (`null`: nobody was asked). `otherCli` is the CLI
 * that is not the managed one: the person's own after "Keep my own", otherwise a `happier` still on
 * PATH — the old copy after "Let Happier manage it". Its commands are shown, never run.
 */
export type DesktopCliChoiceFacts = Readonly<{
    mode: 'managed' | 'own' | null;
    otherCli: Readonly<{
        command: string;
        origin: 'npm' | 'brew' | 'unknown';
        removalCommand: string | null;
        updateCommand: string | null;
    }> | null;
}>;

/**
 * R12 — the exact command that updates the command line the person kept ("Keep my own"). The app
 * never replaces that CLI, so every surface that offers its update shows this command instead —
 * the setup panel, the Updates row and Settings › This computer — and none reads it another way.
 */
export function readKeptCliUpdateCommand(facts: DesktopLocalReadinessFacts): string | null {
    return facts.cliChoice.mode === 'own' ? facts.cliChoice.otherCli?.updateCommand ?? null : null;
}

/** The public release channels a managed CLI can belong to (`@happier-dev/release-runtime`). */
export type DesktopCliChannel = 'stable' | 'preview' | 'publicdev';

export type DesktopCliUpdateFacts = Readonly<{
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    managed: boolean;
}>;

export type DesktopLocalInspection =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed'; error: Readonly<{ code: string; message: string }> }>
    | Readonly<{
        status: 'resolved';
        /** The default-following service's daemon: the relay this Happier home's selection names. */
        facts: DesktopLocalReadinessFacts;
        /**
         * One daemon per relay (`apps/docs/.../accounts/multi-server.mdx`): each pinned service of
         * this home and ring — a relay this computer ALSO serves — with its own facts. `null` or
         * absent is UNKNOWN: the executor that answered (an older hsetup or CLI) could not say, so
         * nothing beyond `facts` is claimed and nothing that needs the list is offered.
         */
        pinnedServices?: readonly DesktopLocalReadinessFacts[] | null;
        /**
         * M6 — THE one completeness signal of this computer's services (`pinnedServices.complete`):
         * `true` only when the executor listed every service here and read each one. Anything else —
         * a list failure, an unreadable service, or an older result without it — is unknown: a relay
         * may have a service here the app cannot see, so nothing that depends on "this relay has
         * none" is offered and no list claims to be whole.
         */
        pinnedServicesComplete?: boolean;
        /**
         * B-03 — the CLI's `pinnedServiceCoexistence` capability: it can install a relay's own
         * service beside the default-following one. It gates only offering "Connect to … too";
         * services already listed are shown whatever it says. Absent is `false` (fail closed).
         */
        pinnedServiceCoexistence?: boolean;
        /**
         * The relays whose own pinned service is listed here but could not be read
         * (`pinnedServices.unreadable[].relayUrl`). A relay named here has a service the app cannot
         * see, so which daemon serves it is UNKNOWN — never the default-following one by elimination.
         */
        pinnedServicesUnreadable?: readonly string[];
        /**
         * A14-02 — the one login-start mode of every service the app manages, computed by the status
         * producer: `null` when they disagree or one could not be read. Settings, the tray and quit
         * read this (`readManagedLoginStartMode`), never the default-following service's own mode.
         */
        managedServiceAutostart?: DesktopBackgroundServiceAutostartMode | null;
        /**
         * A14-01 — how many managed services are running here, counted by the status producer;
         * `null` when some could not be read. Absent is unknown.
         */
        runningManagedServiceCount?: number | null;
        /**
         * R16 — the executor's one list of this computer's services, one row per relay
         * (`listThisComputerServiceRows` in bootstrap), each judged against its relay's own
         * account. `null`/absent: the executor sent none, so no row is claimed.
         */
        serviceRows?: readonly ThisComputerServiceRowFacts[] | null;
    }>;

/** One row of the executor's service list (`daemon.service.status.v1` → `serviceRows`). */
export type ThisComputerServiceRowFacts = Readonly<{
    relayUrl: string;
    state: ThisComputerRelayState;
    appManaged: boolean;
    /**
     * D11-2 — which of this computer's services answers for the relay, decided once by bootstrap's
     * one rule (the relay's installed pinned service wins, else the default-following one when it
     * is on that relay). `resolveThisComputerService` reads it; nothing in the app re-derives it.
     * R12-S1 — the row's only service field (`serviceTargetMode` was always the same value).
     */
    serving: 'default-following' | 'pinned';
    actions: readonly ('start' | 'restart' | 'stop')[];
}>;

type ResolvedDesktopLocalInspection = Extract<DesktopLocalInspection, { status: 'resolved' }>;

/**
 * One of this computer's background services and the daemon it runs: the default-following one,
 * or a pinned one that serves exactly one relay. `serviceTargetMode` is the CLI's own vocabulary,
 * and it is also what a setup run for that relay is told to converge.
 */
export type ThisComputerRelayService = Readonly<{
    facts: DesktopLocalReadinessFacts;
    serviceTargetMode: 'default-following' | 'pinned';
}>;

/** The identity the app selected. Compared against the immutable ambient facts; a change re-runs nothing. */
export type DesktopSetupExpectation = Readonly<{
    relayUrl: string;
    localRelayUrl: string | null;
    accountId: string | null;
}>;

/**
 * INV10 — readiness also needs proof that this daemon is reachable **now**, which is one
 * successful read-only machine RPC through the canonical owner. Absent means the proof has not
 * come back yet, so nothing is ready: the gate fails closed on an unanswered machine.
 */
export type DesktopSetupReachability = 'reachable' | 'unreachable';

export type DesktopLocalSetupInput = Readonly<{
    inspection: DesktopLocalInspection;
    expected: DesktopSetupExpectation;
    reachability?: DesktopSetupReachability;
    /**
     * H6/D6 — the quiet start has already had its turn for these facts. Until then, facts that
     * say "installed, stopped, otherwise aligned" are an unsettled check (`service_start_pending`):
     * the app is about to start the service it already installed. Afterwards they are settled, so
     * a service still stopped once the start has run carries its own failure instead of leaving
     * the surface checking something nothing is going to start.
     */
    backgroundServiceStartAttempted?: boolean;
}>;

/** R14/UD5: the ephemeral in-run facts that decide how a fact is presented. */
export type DesktopSetupEntryContext = Readonly<{
    authenticatedThisRun: boolean;
    /**
     * Whether this app run's first-run setup has already settled — the Home panel has gone away
     * once, ready or declined. `authenticatedThisRun` is set once at sign-in and never cleared, so
     * on its own it would still claim "first run" for maintenance that happens hours later.
     */
    firstRunSettled: boolean;
    /**
     * The user was asked something this attempt needed — to move this device's background service
     * to the selected Relay (UD5), or to vouch for a command line this app's install path did not
     * place — and said no. The computer is still not ready for this relay, so nothing claims
     * ready; but the panel must not keep asking about a choice the user just made, so it steps
     * aside and the existing drift banner carries the state.
     */
    userDeclinedThisAttempt?: boolean;
}>;

export type DesktopLocalSetupState = 'checking' | 'setup' | 'ready' | 'blocked';

/**
 * R11 — setup never blocks the app. `panel`: the Home shows the non-blocking setup panel (progress,
 * an honest failure, Retry, the way to continue without this computer). `hidden`: nothing to show.
 */
export type DesktopLocalSetupPresentation = 'panel' | 'hidden';

export type DesktopLocalSetupReason =
    | 'relay_mismatch'
    | 'not_authenticated'
    | 'account_mismatch'
    | 'machine_unregistered'
    | 'service_not_installed'
    | 'daemon_not_converged'
    | 'runtime_unknown'
    | 'inspection_failed'
    | 'cli_choice_required'
    | 'credentials_unverified'
    | 'reachability_pending'
    | 'service_start_pending'
    | 'machine_unreachable';

export type DesktopLocalSetupSnapshot = Readonly<{
    state: DesktopLocalSetupState;
    presentation: DesktopLocalSetupPresentation;
    reason: DesktopLocalSetupReason | null;
}>;

/**
 * Whether the daemon's configured relay is the one the app expects. Every relay comparison in the
 * setup corridor goes through this one comparer so the UD5 reconciliation check and the readiness
 * check cannot disagree about what "same relay" means.
 */
export function daemonRelayMatchesExpectation(facts: DesktopLocalReadinessFacts, expected: DesktopSetupExpectation): boolean {
    const accepted = expectedRelayKeys(expected);
    if (accepted.size === 0) {
        return false;
    }
    const daemonKeys = [
        facts.server.comparableKey,
        createRelayUrlComparableKeySafe(facts.server.serverUrl),
        createRelayUrlComparableKeySafe(facts.server.publicServerUrl),
        createRelayUrlComparableKeySafe(facts.server.localServerUrl),
    ].filter((key): key is string => typeof key === 'string' && key.length > 0);
    return daemonKeys.some((key) => accepted.has(key));
}

function expectedRelayKeys(expected: DesktopSetupExpectation): ReadonlySet<string> {
    const accepted = new Set<string>();
    for (const url of [expected.relayUrl, expected.localRelayUrl]) {
        const key = createRelayUrlComparableKeySafe(url);
        if (key) accepted.add(key);
    }
    return accepted;
}

/** Whether a relay URL the executor reported (a service row's) is the relay the app expects — same comparer. */
export function relayUrlMatchesExpectation(relayUrl: string, expected: DesktopSetupExpectation): boolean {
    const key = createRelayUrlComparableKeySafe(relayUrl);
    return key !== null && expectedRelayKeys(expected).has(key);
}

/**
 * The service behind one of the executor's rows: the relay's pinned service when the row names it
 * (whatever its own status says — bootstrap listed it and chose it), else the default-following
 * daemon. `null` when the row names a pin whose facts did not come with it.
 */
function readRowService(inspection: ResolvedDesktopLocalInspection, row: ThisComputerServiceRowFacts): ThisComputerRelayService | null {
    if (row.serving !== 'pinned') {
        return { facts: inspection.facts, serviceTargetMode: 'default-following' };
    }
    const key = createRelayUrlComparableKeySafe(row.relayUrl);
    const pinned = key ? inspection.pinnedServices?.find((candidate) => createRelayUrlComparableKeySafe(candidate.server.serverUrl) === key) : undefined;
    return pinned ? { facts: pinned, serviceTargetMode: 'pinned' } : null;
}

/**
 * THE answer to "which of this computer's daemons answers for this relay?" — asked by readiness,
 * the readiness proof, the move question and every surface describing this computer, so "this
 * computer is connected here" cannot mean two things.
 *
 * D11-2/R12-F1 — the rule is bootstrap's, not the app's, and the app applies no filter of its own
 * before it: the executor's row for the relay names the service that serves it (`serving`) and the
 * app reads the facts that row designates — the row named by the relay's own URL first (A12-01),
 * an alias match only when no row or unreadable service names it. With no row for the relay nothing here serves it, and the
 * default-following daemon is the one a move would take there and the one every mismatch describes —
 * unless the relay's own service is listed but unreadable. That is `null`: UNKNOWN, never the default.
 */
export function resolveThisComputerService(
    inspection: ResolvedDesktopLocalInspection,
    expected: DesktopSetupExpectation,
): ThisComputerRelayService | null {
    const rows = inspection.serviceRows ?? [];
    // A12-01 — the row that names the relay itself comes first, and so does a listed service for
    // it that could not be read: another daemon also answering on that URL (its public or local
    // alias) never outranks the service bootstrap designated for the relay.
    const exact = rows.find((row) => relayUrlMatchesExpectation(row.relayUrl, expected));
    if (exact) {
        return readRowService(inspection, exact);
    }
    if (inspection.pinnedServicesUnreadable?.some((relayUrl) => relayUrlMatchesExpectation(relayUrl, expected))) {
        return null;
    }
    // Only then a row whose service answers on the relay under another of its URLs.
    for (const row of rows) {
        const service = readRowService(inspection, row);
        if (service && daemonRelayMatchesExpectation(service.facts, expected)) {
            return service;
        }
    }
    return { facts: inspection.facts, serviceTargetMode: 'default-following' };
}

/**
 * Every relay this computer has a service for: the services the executor lists, one per row
 * (R16 — the same list the popover, Settings and the tray show). A computer with none lists nothing
 * (R10: a relay in a config file is not a daemon); a pin that could not be read is not claimed.
 */
export function listThisComputerRelayServices(inspection: DesktopLocalInspection): readonly ThisComputerRelayService[] {
    if (inspection.status !== 'resolved') {
        return [];
    }
    return (inspection.serviceRows ?? []).flatMap((row) => {
        const service = readRowService(inspection, row);
        return service ? [service] : [];
    });
}

/**
 * H6/D6 across relays — some service this computer runs for any relay is installed, signed in and
 * simply stopped (on-demand after the last quit, or at-login stopped by something else). One
 * login-start setting governs every service the app manages, so the quiet start is owed to each of
 * them, not only to the one serving the app's relay. A service that is not signed in would not come
 * up by starting it; setup owns that.
 */
export function thisComputerHasServiceToStart(inspection: DesktopLocalInspection): boolean {
    return listThisComputerRelayServices(inspection).some((service) => (
        thisComputerAppManagesService(service)
        && installedServiceNeedsStart(service.facts)
        && !daemonNeedsAuthFromFacts(service.facts)
        && service.facts.auth.credentialState !== 'unknown'
    ));
}

/**
 * H2 — whether the app starts, stops and sets login start for this service: the default-following
 * one (D2), and a pinned one only when the app installed it. A service the user set up is shown,
 * never driven.
 */
export function thisComputerAppManagesService(service: ThisComputerRelayService): boolean {
    return service.serviceTargetMode === 'default-following' || service.facts.service.managedBy === 'desktop';
}

/**
 * M4 — how a daemon here stands for its relay: `connected` (it answers, is signed in and its
 * service runs it converged), `offline` (set up, but no daemon answers) or `needs_attention` (it
 * answers but needs sign-in, runs as another account, or has not converged). The executor judges
 * every relay against the account that relay validated (`serviceRows`); only the app's own relay is
 * judged again here, against the account the app is on (R16: one owner per judgement).
 */
export type ThisComputerRelayState = 'connected' | 'offline' | 'needs_attention';

/** The app relay's service, judged against the app's account by the readiness owner. */
export function resolveThisComputerRelayState(
    facts: DesktopLocalReadinessFacts,
    appRelay: DesktopSetupExpectation,
): ThisComputerRelayState {
    if (!facts.runtimeConvergence?.controlReachable) {
        return 'offline';
    }
    return appRelay.accountId !== null && resolveSetupReason(facts, appRelay) === null ? 'connected' : 'needs_attention';
}

function resolveSetupReason(facts: DesktopLocalReadinessFacts, expected: DesktopSetupExpectation): DesktopLocalSetupReason | null {
    if (!daemonRelayMatchesExpectation(facts, expected)) {
        return 'relay_mismatch';
    }
    if (facts.auth.credentialState === 'unknown') {
        return 'credentials_unverified';
    }
    if (facts.auth.credentialState !== 'valid' || !facts.auth.validatedAccountId) {
        return 'not_authenticated';
    }
    if (facts.auth.validatedAccountId !== expected.accountId) {
        return 'account_mismatch';
    }
    if (!facts.auth.machineId) {
        return 'machine_unregistered';
    }
    if (!facts.service.installed) {
        return 'service_not_installed';
    }
    const convergence = facts.runtimeConvergence;
    if (!convergence) {
        return 'runtime_unknown';
    }
    if (
        !convergence.controlReachable
        || !convergence.serviceOwnsRunningDaemon
        || !convergence.machineIdMatches
        || !convergence.cliVersionMatches
    ) {
        return 'daemon_not_converged';
    }
    return null;
}

/**
 * Whether this computer's daemon still needs to be paired for the relay it is configured for: the
 * relay rejected its credentials or it has none, or it has no machine of its own yet.
 *
 * `unknown` is not one of those (U9): offline, the CLI could not ask the relay, which says nothing
 * about the credentials. Reading it as "needs to sign in" put a false claim and an Authenticate
 * action on every surface describing this computer until the app relaunched.
 *
 * It is the one projection of "needs auth" the desktop surfaces share — the drift classifier and
 * the local-daemon settings row — so the banner and the row beside it cannot describe the same
 * computer differently. Readiness is never this: that is `verifyCurrentTarget` alone (INV8/INV10).
 */
export function daemonNeedsAuthFromFacts(facts: DesktopLocalReadinessFacts): boolean {
    if (facts.auth.credentialState === 'unknown') {
        return false;
    }
    return facts.auth.credentialState !== 'valid' || facts.auth.machineId === null;
}

/**
 * H6/D6 — the installed service is the app's own and is simply not running.
 *
 * That is not drift. For an on-demand service it is the settings toggle's promise ("this computer
 * answers while the app is open") being kept; for an at-login one that something stopped, it is
 * the same quiet start — the same fact must not get a heavier surface because of how the service
 * starts at login (D6). Every other fact has to be aligned first — this is only ever reached for
 * `daemon_not_converged`, i.e. the relay, credentials, account, machine id and installation all
 * match what the app expects.
 */
function installedServiceNeedsStart(facts: DesktopLocalReadinessFacts): boolean {
    return facts.service.installed && !facts.service.running;
}

/**
 * A14-02 — the one login-start setting as the person sees it: the status producer's common mode of
 * every managed service. `null` (unknown) before a read, after a failed one, when the producer sent
 * none, and when the managed services disagree.
 */
export function readManagedLoginStartMode(inspection: DesktopLocalInspection): DesktopBackgroundServiceAutostartMode | null {
    return inspection.status === 'resolved' ? inspection.managedServiceAutostart ?? null : null;
}

/**
 * Whether the app's re-read facts already describe a converged local runtime for this identity
 * (INV8). It is the same private reason resolver the snapshot uses, so the gate cannot disagree
 * with the snapshot about when the reachability proof is worth issuing.
 */
export function desktopLocalRuntimeConverged(
    inspection: DesktopLocalInspection,
    expected: DesktopSetupExpectation,
): boolean {
    if (inspection.status !== 'resolved' || !expected.accountId) {
        return false;
    }
    const service = resolveThisComputerService(inspection, expected);
    return service !== null && resolveSetupReason(service.facts, expected) === null;
}

/**
 * The one pure entry policy (plan §3.1). `(facts, entryContext) → state + presentation`.
 *
 * "Ready" is proven by the running daemon's convergence and the relay-validated account (INV8)
 * **and** by the machine answering a read-only RPC (INV10); credentials on disk beside a live PID
 * prove nothing, and neither does convergence alone.
 *
 * One rule decides presentation, and it turns on whether the facts have SETTLED (R14): while a
 * check is still running nothing is wrong yet, so the Home shows nothing — except on a first run,
 * where the panel says this computer is being checked. Once a fact settles against the app —
 * setup needed, credentials unverifiable, the inspection failed, the machine unreachable — the
 * panel presents it, never hides it: a settled failure with nothing on screen is how a failed
 * setup became silently permanent. The app itself is usable throughout (R11).
 */
export function deriveDesktopLocalSetupSnapshot(
    input: DesktopLocalSetupInput,
    entryContext: DesktopSetupEntryContext,
): DesktopLocalSetupSnapshot {
    // The user just answered this attempt's question with "no". Presenting it again would be a
    // retry trap, so the panel steps aside and the existing drift / repair entry carries the state
    // until they return to it.
    const firstRun = entryContext.authenticatedThisRun && !entryContext.firstRunSettled;
    const settled: DesktopLocalSetupPresentation = entryContext.userDeclinedThisAttempt ? 'hidden' : 'panel';
    const unsettled: DesktopLocalSetupPresentation = firstRun && !entryContext.userDeclinedThisAttempt
        ? 'panel'
        : 'hidden';

    if (input.inspection.status === 'pending' || !input.expected.accountId) {
        return { state: 'checking', presentation: unsettled, reason: null };
    }
    if (input.inspection.status === 'failed') {
        // R12 — the read failed on a `happier` nobody chose yet (or the kept one). Re-reading can
        // never change that; the answer can, and setup's first step asks for it.
        if (input.inspection.error.code === 'cli_choice_required') {
            return { state: 'setup', presentation: settled, reason: 'cli_choice_required' };
        }
        return { state: 'blocked', presentation: settled, reason: 'inspection_failed' };
    }

    const service = resolveThisComputerService(input.inspection, input.expected);
    if (!service) {
        // R12-F1 — the relay's own service is listed but could not be read: nothing can be proven
        // about it and nothing may be set up over it; the read is what failed.
        return { state: 'blocked', presentation: settled, reason: 'inspection_failed' };
    }
    const reason = resolveSetupReason(service.facts, input.expected);
    if (reason === null) {
        if (input.reachability === 'reachable') {
            return { state: 'ready', presentation: 'hidden', reason: null };
        }
        if (input.reachability === 'unreachable') {
            return { state: 'blocked', presentation: settled, reason: 'machine_unreachable' };
        }
        return { state: 'checking', presentation: unsettled, reason: 'reachability_pending' };
    }
    if (reason === 'credentials_unverified') {
        // The relay could not be reached to say whether the stored credentials are still good.
        // That is a fact about the CHECK, not about this computer. Nothing re-reads on its own, so
        // it lasts until the next inspection (a relaunch, Retry, or Refresh in Settings) — nothing
        // is ready, and nothing is presented over it either.
        //
        // A first run has nothing set up to fall back to, and nothing re-inspects on its own, so
        // leaving it unsettled there is a panel that checks forever with no action. The executor
        // is the owner of "validate the credentials for this relay": it pairs if the relay answers
        // now, and fails by name — with a Retry — if it does not.
        return firstRun
            ? { state: 'setup', presentation: settled, reason }
            : { state: 'blocked', presentation: unsettled, reason };
    }
    // The quiet start starts every service the app manages (one login-start setting governs them
    // all), so a stopped relay-own service gets it exactly like the default-following one.
    if (reason === 'daemon_not_converged'
        && !input.backgroundServiceStartAttempted
        && installedServiceNeedsStart(service.facts)) {
        return { state: 'checking', presentation: unsettled, reason: 'service_start_pending' };
    }
    return { state: 'setup', presentation: settled, reason };
}
