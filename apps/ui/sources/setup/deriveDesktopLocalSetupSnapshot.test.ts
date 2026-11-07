import { describe, expect, it } from 'vitest';

import { listThisComputerRelayRows } from './thisComputerRelayRows';

import {
    daemonNeedsAuthFromFacts,
    deriveDesktopLocalSetupSnapshot,
    desktopLocalRuntimeConverged,
    resolveThisComputerService,
    thisComputerHasServiceToStart,
    resolveThisComputerRelayState,
    type DesktopLocalReadinessFacts,
    type DesktopLocalSetupInput,
} from './deriveDesktopLocalSetupSnapshot';

const RELAY_URL = 'https://relay.example.test';

function readyFacts(overrides: Partial<{
    server: Partial<DesktopLocalReadinessFacts['server']>;
    auth: Partial<DesktopLocalReadinessFacts['auth']>;
    service: Partial<DesktopLocalReadinessFacts['service']>;
    runtimeConvergence: Partial<NonNullable<DesktopLocalReadinessFacts['runtimeConvergence']>> | null;
}> = {}): DesktopLocalReadinessFacts {
    return {
        acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed', version: null, channel: null },
        server: {
            serverUrl: RELAY_URL,
            publicServerUrl: RELAY_URL,
            localServerUrl: null,
            comparableKey: 'https://relay.example.test',
            ...overrides.server,
        },
        auth: {
            credentialState: 'valid',
            validatedAccountId: 'acct_app',
            accountId: 'acct_app',
            accountLabel: null,
            machineId: 'machine-1',
            ...overrides.auth,
        },
        service: { installed: true, running: true, autostart: null, targetMode: 'default-following', ...overrides.service },
        runtimeConvergence: overrides.runtimeConvergence === null
            ? null
            : {
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: true,
                cliVersionMatches: true,
                ...overrides.runtimeConvergence,
            },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    };
}

function input(overrides: Partial<DesktopLocalSetupInput> = {}): DesktopLocalSetupInput {
    return {
        inspection: { status: 'resolved', facts: readyFacts() },
        expected: { relayUrl: RELAY_URL, localRelayUrl: null, accountId: 'acct_app' },
        ...overrides,
    };
}

describe('deriveDesktopLocalSetupSnapshot', () => {
    it('reveals a machine whose running daemon matches the app relay and account', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'reachable' }), { authenticatedThisRun: true, firstRunSettled: false })).toEqual({
            state: 'ready',
            presentation: 'hidden',
            reason: null,
        });
    });

    it('never consults an account-wide machine count: a returning user with machines elsewhere and an unconfigured local daemon needs setup (A4)', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    auth: { credentialState: 'missing', validatedAccountId: null, accountId: null, machineId: null },
                    service: { installed: false, running: false },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
                }),
            },
        }), { authenticatedThisRun: true, firstRunSettled: false });

        expect(snapshot).toEqual({ state: 'setup', presentation: 'panel', reason: 'not_authenticated' });
    });

    it('shows the checking panel on the Home while facts are unresolved right after authenticating (B3/R11)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: true, firstRunSettled: false })).toEqual({
            state: 'checking',
            presentation: 'panel',
            reason: null,
        });
    });

    it('shows nothing while facts resolve on an ordinary relaunch, then presents the panel once facts prove the runtime unconfigured (R14)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: false, firstRunSettled: false })).toEqual({
            state: 'checking',
            presentation: 'hidden',
            reason: null,
        });

        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: false, running: false },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
                }),
            },
        }), { authenticatedThisRun: false, firstRunSettled: false })).toEqual({
            state: 'setup',
            presentation: 'panel',
            reason: 'service_not_installed',
        });
    });

    it('treats a healthy daemon on a different relay as setup, not ready', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: {
                        serverUrl: 'https://other.example.test',
                        publicServerUrl: 'https://other.example.test',
                        comparableKey: 'https://other.example.test',
                    },
                }),
            },
        }), { authenticatedThisRun: false, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'relay_mismatch' });
    });

    it('treats a healthy daemon validated for a different account as setup, not ready', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({ auth: { validatedAccountId: 'acct_other', accountId: 'acct_other' } }),
            },
        }), { authenticatedThisRun: false, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'account_mismatch' });
    });

    it('accepts the daemon local relay as the same relay when the app also knows that local url', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: {
                        serverUrl: 'http://127.0.0.1:3005',
                        publicServerUrl: 'http://127.0.0.1:3005',
                        localServerUrl: null,
                        comparableKey: 'http://127.0.0.1:3005',
                    },
                }),
            },
            expected: { relayUrl: RELAY_URL, localRelayUrl: 'http://127.0.0.1:3005', accountId: 'acct_app' },
            reachability: 'reachable',
        }), { authenticatedThisRun: false, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'ready' });
    });

    it('does not call a daemon ready from credentials on disk beside a live PID: the running daemon must carry the expected machine id (D1)', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({ runtimeConvergence: { machineIdMatches: false } }),
            },
        }), { authenticatedThisRun: true, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'setup', presentation: 'panel', reason: 'daemon_not_converged' });
    });

    it.each([
        ['controlReachable', { controlReachable: false }],
        ['serviceOwnsRunningDaemon', { serviceOwnsRunningDaemon: false }],
        ['cliVersionMatches', { cliVersionMatches: false }],
    ] as const)('requires %s from the running daemon', (_label, convergence) => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'resolved', facts: readyFacts({ runtimeConvergence: convergence }) },
        }), { authenticatedThisRun: false, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'daemon_not_converged' });
    });

    it('cannot call a machine ready when the CLI did not describe the running daemon at all', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'resolved', facts: readyFacts({ runtimeConvergence: null }) },
        }), { authenticatedThisRun: false, firstRunSettled: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'runtime_unknown' });
    });

    it('is blocked with a visible retry, not silently ready or silently setup, when the inspection failed', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'failed', error: { code: 'cli_spawn_failed', message: 'boom' } },
        }), { authenticatedThisRun: true, firstRunSettled: false })).toEqual({ state: 'blocked', presentation: 'panel', reason: 'inspection_failed' });

        // A SETTLED failure on a relaunch keeps its error, Details and Retry on the Home panel.
        // Showing nothing would hide the only surface that can recover it, which is how a failed
        // setup became silently permanent (R14).
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'failed', error: { code: 'cli_spawn_failed', message: 'boom' } },
        }), { authenticatedThisRun: false, firstRunSettled: false })).toEqual({ state: 'blocked', presentation: 'panel', reason: 'inspection_failed' });
    });

    it('routes a read that failed on a CLI nobody chose yet into setup, whose first step is the one-CLI question (R12)', () => {
        // Retrying the read can never change that it fails; only the answer can. So it is setup,
        // not a blocked panel whose only action re-reads.
        for (const context of [
            { authenticatedThisRun: true, firstRunSettled: false },
            { authenticatedThisRun: false, firstRunSettled: false },
        ]) {
            expect(deriveDesktopLocalSetupSnapshot(input({
                inspection: { status: 'failed', error: { code: 'cli_choice_required', message: 'The Happier CLI at /usr/local/bin/happier could not answer' } },
            }), context)).toEqual({ state: 'setup', presentation: 'panel', reason: 'cli_choice_required' });
        }
        // Declining the question for this attempt steps the panel aside like any other decline.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'failed', error: { code: 'cli_choice_required', message: 'x' } },
        }), { authenticatedThisRun: false, firstRunSettled: false, userDeclinedThisAttempt: true })).toMatchObject({ state: 'setup', presentation: 'hidden' });
    });

    it('keeps an unverifiable credential check off the Home panel on a relaunch (H3)', () => {
        // `unknown` means the CLI could not reach the relay to validate what it has — a transient
        // network fact about the check, not a settled fact about this computer. Nothing is ready,
        // so the state stays `blocked`, but a relaunch does not present it; the first run is
        // covered by the next case.
        const credentialsUnverified = input({
            inspection: { status: 'resolved', facts: readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } }) },
        });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: false, firstRunSettled: false }))
            .toEqual({ state: 'blocked', presentation: 'hidden', reason: 'credentials_unverified' });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'blocked', presentation: 'hidden', reason: 'credentials_unverified' });
    });

    it('never reads an unverifiable credential check as "needs to sign in" (U9)', () => {
        // Offline, the CLI cannot ask the relay about its credentials. That says nothing about
        // them, so the surfaces describing this computer must not claim it needs approval.
        expect(daemonNeedsAuthFromFacts(readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } }))).toBe(false);
        expect(daemonNeedsAuthFromFacts(readyFacts({ auth: { credentialState: 'rejected', validatedAccountId: null } }))).toBe(true);
        expect(daemonNeedsAuthFromFacts(readyFacts({ auth: { machineId: null } }))).toBe(true);
    });

    it('gives the first run a way out of an unverifiable credential check instead of checking forever (F3)', () => {
        // On a relaunch the drift banner carries this state and the next read clears it. On a
        // first run the panel would show "Checking this computer" with no action, and nothing
        // re-inspects. So it is a settled setup reason there — the executor
        // owns "validate the credentials for this relay" and either pairs or fails by name with a
        // Retry, which is what R14 means by never becoming silently optional.
        const credentialsUnverified = input({
            inspection: { status: 'resolved', facts: readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } }) },
        });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: true, firstRunSettled: false }))
            .toEqual({ state: 'setup', presentation: 'panel', reason: 'credentials_unverified' });
        // A decision the user already made still takes the panel away rather than asking again.
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: true, firstRunSettled: false, userDeclinedThisAttempt: true }))
            .toEqual({ state: 'setup', presentation: 'hidden', reason: 'credentials_unverified' });
    });

    it('keeps an UNSETTLED relaunch check off the Home, and only a settled failure takes the panel (R14)', () => {
        // Still reading the facts: nothing is wrong yet, so there is nothing to present.
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'checking', presentation: 'hidden', reason: null });
        // Facts converged; the reachability proof is still in flight. Also unsettled.
        expect(deriveDesktopLocalSetupSnapshot(input(), { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'checking', presentation: 'hidden', reason: 'reachability_pending' });
    });

    it('shows the checking panel only until the first-run setup has settled once; later maintenance shows only settled facts (R11)', () => {
        // `authenticatedThisRun` stays true for the whole app run, so it cannot mean "this is the
        // first run's setup". Once that has settled, later maintenance presents only settled
        // facts, never a checking panel.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: { serverUrl: 'https://other.example.test', publicServerUrl: 'https://other.example.test', comparableKey: 'https://other.example.test' },
                }),
            },
        }), { authenticatedThisRun: true, firstRunSettled: true }))
            .toEqual({ state: 'setup', presentation: 'panel', reason: 'relay_mismatch' });

        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: true, firstRunSettled: true }))
            .toEqual({ state: 'blocked', presentation: 'panel', reason: 'machine_unreachable' });
    });

    it('never reveals on converged facts alone: the machine has to answer first (INV10)', () => {
        // Convergence describes the daemon this computer is running. It cannot say whether the
        // relay can reach it, so without the read-only machine RPC there is nothing to reveal on.
        expect(deriveDesktopLocalSetupSnapshot(input(), { authenticatedThisRun: true, firstRunSettled: false }))
            .toEqual({ state: 'checking', presentation: 'panel', reason: 'reachability_pending' });
    });

    it('fails closed on the Home panel when the machine does not answer (INV10)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: true, firstRunSettled: false }))
            .toEqual({ state: 'blocked', presentation: 'panel', reason: 'machine_unreachable' });
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: false, firstRunSettled: false }))
            .toEqual({ state: 'blocked', presentation: 'panel', reason: 'machine_unreachable' });
    });

    it('needs the app account before it can compare identities', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({
            expected: { relayUrl: RELAY_URL, localRelayUrl: null, accountId: null },
        }), { authenticatedThisRun: true, firstRunSettled: false })).toEqual({ state: 'checking', presentation: 'panel', reason: null });
    });
    /** An installed, stopped, on-demand service on the relay and account the app is on (H6). */
    function onDemandStoppedInput(overrides: Partial<DesktopLocalSetupInput> = {}): DesktopLocalSetupInput {
        return input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: true, running: false, autostart: 'on-demand' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
            ...overrides,
        });
    }

    it('treats an installed on-demand service that is simply not running yet as a check, not a blocking setup (H6)', () => {
        // "Starts when you open the app" is what the user asked for, so the app starting it is
        // not maintenance to be announced: it is an unsettled check, exactly like the reachability
        // proof. Nothing is ready yet and nothing claims to be.
        expect(deriveDesktopLocalSetupSnapshot(onDemandStoppedInput(), { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'checking', presentation: 'hidden', reason: 'service_start_pending' });
        expect(deriveDesktopLocalSetupSnapshot(onDemandStoppedInput(), { authenticatedThisRun: true, firstRunSettled: false }))
            .toEqual({ state: 'checking', presentation: 'panel', reason: 'service_start_pending' });
    });

    it('settles the on-demand start once it has had its turn, so the surface carries it instead of checking forever (H6)', () => {
        expect(deriveDesktopLocalSetupSnapshot(
            onDemandStoppedInput({ backgroundServiceStartAttempted: true }),
            { authenticatedThisRun: false, firstRunSettled: true },
        )).toEqual({ state: 'setup', presentation: 'panel', reason: 'daemon_not_converged' });
    });

    it('never quiet-starts a service for a relay or account the app is not on (H6)', () => {
        // The quiet start is only the on-demand deal being honoured. A daemon configured for
        // another relay needs the executor and the blocking surface, whatever its autostart mode.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: { serverUrl: 'https://other.example.test', publicServerUrl: 'https://other.example.test', comparableKey: 'https://other.example.test' },
                    service: { installed: true, running: false, autostart: 'on-demand' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
        }), { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'setup', presentation: 'panel', reason: 'relay_mismatch' });
    });

    it('quietly starts a stopped at-login service exactly as it does an on-demand one (D6)', () => {
        // The same fact — the app's own service, aligned in every way, simply stopped — used to
        // get the setup surface and the full four-stage executor when the service was at-login,
        // and a quiet start when it was on-demand. Starting it is a check either way.
        const stoppedAtLogin = input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: true, running: false, autostart: 'at-login' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
        });
        expect(deriveDesktopLocalSetupSnapshot(stoppedAtLogin, { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'checking', presentation: 'hidden', reason: 'service_start_pending' });
        // Once the start has had its turn, a service still stopped is a real failure again.
        expect(deriveDesktopLocalSetupSnapshot({ ...stoppedAtLogin, backgroundServiceStartAttempted: true }, { authenticatedThisRun: false, firstRunSettled: true }))
            .toEqual({ state: 'setup', presentation: 'panel', reason: 'daemon_not_converged' });
    });
});

describe('one daemon per relay', () => {
    const OTHER_RELAY = 'https://other-relay.example.test';
    const defaultElsewhere = readyFacts({ server: { serverUrl: OTHER_RELAY, publicServerUrl: OTHER_RELAY, comparableKey: 'other-relay.example.test' } });
    const settledRun = { authenticatedThisRun: false, firstRunSettled: true };
    /** The executor's row for a relay: which service bootstrap's one rule says serves it (D11-2). */
    const rowServedBy = (facts: DesktopLocalReadinessFacts, serving: 'pinned' | 'default-following') => ({
        relayUrl: facts.server.serverUrl ?? '',
        state: 'connected' as const,
        appManaged: true,
        serving,
        actions: ['restart', 'stop'] as const,
    });

    it('is ready on a relay its own pinned service serves, even though the default-following one serves another', () => {
        const pinned = readyFacts({ service: { targetMode: 'pinned' }, auth: { machineId: 'machine-pinned' } });
        const inspection = {
            status: 'resolved' as const,
            facts: defaultElsewhere,
            pinnedServices: [pinned],
            serviceRows: [rowServedBy(defaultElsewhere, 'default-following'), rowServedBy(pinned, 'pinned')],
        };

        expect(deriveDesktopLocalSetupSnapshot(input({ inspection, reachability: 'reachable' }), settledRun))
            .toEqual({ state: 'ready', presentation: 'hidden', reason: null });
        expect(desktopLocalRuntimeConverged(inspection, input().expected)).toBe(true);
        expect(resolveThisComputerService(inspection, input().expected)).toEqual({ facts: pinned, serviceTargetMode: 'pinned' });
    });

    it('reads which service serves a relay from the executor\'s row, even when both are on it (D11-2)', () => {
        const defaultHere = readyFacts({ auth: { machineId: 'machine-default' } });
        const pinnedHere = readyFacts({ service: { targetMode: 'pinned' }, auth: { machineId: 'machine-pinned' } });
        const servedBy = (serving: 'pinned' | 'default-following') => ({
            status: 'resolved' as const,
            facts: defaultHere,
            pinnedServices: [pinnedHere],
            serviceRows: [rowServedBy(serving === 'pinned' ? pinnedHere : defaultHere, serving)],
        });

        expect(resolveThisComputerService(servedBy('pinned'), input().expected)).toEqual({ facts: pinnedHere, serviceTargetMode: 'pinned' });
        expect(resolveThisComputerService(servedBy('default-following'), input().expected)).toEqual({ facts: defaultHere, serviceTargetMode: 'default-following' });
        // No row names the relay's pinned service: the app does not decide on its own that it serves.
        expect(resolveThisComputerService({ status: 'resolved', facts: defaultElsewhere, pinnedServices: [pinnedHere] }, input().expected))
            .toEqual({ facts: defaultElsewhere, serviceTargetMode: 'default-following' });
    });

    it('describes the default-following daemon when no service of this computer serves the app relay', () => {
        const inspection = {
            status: 'resolved' as const,
            facts: defaultElsewhere,
            pinnedServices: [readyFacts({ server: { serverUrl: 'https://third.example.test', publicServerUrl: null, comparableKey: 'third.example.test' }, service: { targetMode: 'pinned' } })],
        };
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection }), settledRun)).toMatchObject({ state: 'setup', reason: 'relay_mismatch' });
        expect(resolveThisComputerService(inspection, input().expected)).toEqual({ facts: defaultElsewhere, serviceTargetMode: 'default-following' });
    });

    it('gives a stopped pinned service the same quiet start: one login-start setting governs every service here', () => {
        const stoppedPinned = readyFacts({
            service: { targetMode: 'pinned', running: false, managedBy: 'desktop' },
            runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
        });
        const inspection = {
            status: 'resolved' as const,
            facts: defaultElsewhere,
            pinnedServices: [stoppedPinned],
            serviceRows: [rowServedBy(stoppedPinned, 'pinned')],
        };
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection }), settledRun)).toMatchObject({ state: 'checking', reason: 'service_start_pending' });
        expect(thisComputerHasServiceToStart(inspection)).toBe(true);
    });

    it('judges the app relay\'s service against the app\'s account with the readiness rule (R10-4; other relays are the executor\'s rows, R16)', () => {
        expect(resolveThisComputerRelayState(readyFacts(), input().expected)).toBe('connected');
        expect(resolveThisComputerRelayState(readyFacts({ auth: { validatedAccountId: null } }), input().expected)).toBe('needs_attention');
        expect(resolveThisComputerRelayState(readyFacts({ service: { installed: false } }), input().expected)).toBe('needs_attention');
        expect(resolveThisComputerRelayState(readyFacts(), { ...input().expected, accountId: 'acct_someone_else' })).toBe('needs_attention');
        expect(resolveThisComputerRelayState(readyFacts({
            runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
        }), input().expected)).toBe('offline');
    });

    it('reads unverifiable credentials on the app relay as needing attention (N6)', () => {
        const unverified = readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } });
        expect(resolveThisComputerRelayState(unverified, input().expected)).toBe('needs_attention');
    });

    it('names a service to start on any relay the executor lists here, never one that could not start anyway', () => {
        const stopped = { service: { running: false }, runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false } } as const;
        const running = readyFacts();
        const otherRelay = { server: { serverUrl: OTHER_RELAY, publicServerUrl: OTHER_RELAY, comparableKey: null } };
        const stoppedPin = (managedBy: 'desktop' | null) => readyFacts({ ...stopped, ...otherRelay, service: { targetMode: 'pinned', running: false, managedBy } });
        /** The services the executor lists, one row each (R16): what "every service here" means. */
        const listed = (facts: DesktopLocalReadinessFacts, pins: DesktopLocalReadinessFacts[]) => ({
            status: 'resolved' as const,
            facts,
            pinnedServices: pins,
            serviceRows: [rowServedBy(facts, 'default-following'), ...pins.map((pin) => rowServedBy(pin, 'pinned'))],
        });
        expect(thisComputerHasServiceToStart(listed(running, [stoppedPin('desktop')]))).toBe(true);
        expect(thisComputerHasServiceToStart(listed(readyFacts(stopped), []))).toBe(true);
        expect(thisComputerHasServiceToStart(listed(running, []))).toBe(false);
        // Signed out: starting it would not bring it up; setup owns that.
        expect(thisComputerHasServiceToStart(listed(readyFacts({ ...stopped, auth: { credentialState: 'missing', machineId: null } }), []))).toBe(false);
        expect(thisComputerHasServiceToStart({ status: 'pending' })).toBe(false);
        // H2: a relay service the user set up is theirs to start.
        expect(thisComputerHasServiceToStart(listed(running, [stoppedPin(null)]))).toBe(false);
        // R12-F1: only the executor's list says which services exist — facts it did not list claim none.
        expect(thisComputerHasServiceToStart({ status: 'resolved', facts: running, pinnedServices: [stoppedPin('desktop')], serviceRows: [rowServedBy(running, 'default-following')] })).toBe(false);
    });

    it('takes the pin a row names as it is, even when its status says it is not installed (R12-F1)', () => {
        // Bootstrap listed the relay's own service and says it serves the relay; its definition no
        // longer reads as installed. That is this relay's service needing setup — never a reason to
        // describe (and move) the default-following daemon instead.
        const brokenPin = readyFacts({ service: { targetMode: 'pinned', installed: false, running: false, managedBy: 'desktop' } });
        const inspection = {
            status: 'resolved' as const,
            facts: defaultElsewhere,
            pinnedServices: [brokenPin],
            serviceRows: [rowServedBy(defaultElsewhere, 'default-following'), rowServedBy(brokenPin, 'pinned')],
        };
        expect(resolveThisComputerService(inspection, input().expected)).toEqual({ facts: brokenPin, serviceTargetMode: 'pinned' });
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection }), settledRun)).toMatchObject({ state: 'setup', reason: 'service_not_installed' });
    });

    it('honors the row that names the relay exactly before any alias another daemon answers on (A12-01)', () => {
        // The default-following daemon serves another relay but also answers on the app relay's URL
        // (its local/public alias); the app relay has its own pin, and bootstrap's row says so.
        const aliasingDefault = readyFacts({ server: { serverUrl: OTHER_RELAY, publicServerUrl: OTHER_RELAY, localServerUrl: RELAY_URL, comparableKey: null }, auth: { machineId: 'machine-default' } });
        const pin = readyFacts({ service: { targetMode: 'pinned', managedBy: 'desktop' }, auth: { machineId: 'machine-pin' } });
        const inspection = {
            status: 'resolved' as const,
            facts: aliasingDefault,
            pinnedServices: [pin],
            pinnedServicesComplete: true,
            serviceRows: [rowServedBy(aliasingDefault, 'default-following'), rowServedBy(pin, 'pinned')],
        };
        expect(resolveThisComputerService(inspection, input().expected)).toEqual({ facts: pin, serviceTargetMode: 'pinned' });
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection, reachability: 'reachable' }), settledRun)).toMatchObject({ state: 'ready' });
        const rows = listThisComputerRelayRows(inspection, input().expected);
        expect(rows.status === 'listed' ? rows.rows.map((row) => [row.relayUrl, row.appRelay]) : null).toEqual([
            [OTHER_RELAY, false],
            [RELAY_URL, true],
        ]);
        // An unreadable pin listed for the app relay is honored before the alias, too: unknown.
        const unreadable = { ...inspection, pinnedServices: [], pinnedServicesComplete: false, pinnedServicesUnreadable: [RELAY_URL], serviceRows: [rowServedBy(aliasingDefault, 'default-following')] };
        expect(resolveThisComputerService(unreadable, input().expected)).toBeNull();
    });

    it('knows nothing about a relay whose own service could not be read — never the default instead (R12-F1)', () => {
        const inspection = {
            status: 'resolved' as const,
            facts: defaultElsewhere,
            pinnedServices: [],
            pinnedServicesComplete: false,
            pinnedServicesUnreadable: [RELAY_URL],
            serviceRows: [rowServedBy(defaultElsewhere, 'default-following')],
        };
        expect(resolveThisComputerService(inspection, input().expected)).toBeNull();
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection, reachability: 'reachable' }), settledRun))
            .toMatchObject({ state: 'blocked', reason: 'inspection_failed' });
        expect(desktopLocalRuntimeConverged(inspection, input().expected)).toBe(false);
        // A relay no unreadable service names is still described by the default-following daemon.
        expect(resolveThisComputerService({ ...inspection, pinnedServicesUnreadable: ['https://elsewhere.example.test'] }, input().expected))
            .toEqual({ facts: defaultElsewhere, serviceTargetMode: 'default-following' });
    });
});
