import { describe, expect, it } from 'vitest';

import { classifyRelayDrift, resolveKnownRelayEquivalentUrl } from './relayDriftModel';

describe('classifyRelayDrift', () => {
    it('treats localhost variants as the same relay identity', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'http://localhost:3012/app',
            daemonRelayUrl: 'http://127.0.0.1:3012/api',
            daemonAccountId: 'acct_1',
        })).toMatchObject({
            status: 'aligned',
        });
    });

    it('accepts alternate daemon relay urls when matching the active relay identity', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay.example.test/app',
            daemonRelayUrl: 'http://127.0.0.1:3012/api',
            daemonAlternateRelayUrls: ['https://relay.example.test'],
            daemonAccountId: 'acct_1',
        })).toMatchObject({
            status: 'aligned',
        });
    });

    it('flags daemon relay URL drift by comparable key', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay-a.example.test/path',
            daemonRelayUrl: 'https://relay-b.example.test/api',
            daemonAccountId: 'acct_1',
        })).toMatchObject({
            status: 'daemon_url_mismatch',
            repairAction: {
                kind: 'setupThisComputer',
            },
        });
    });

    it('flags a missing daemon relay configuration when the UI is connected but the daemon is not configured', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay-a.example.test/path',
            daemonRelayUrl: null,
            daemonAccountId: null,
        })).toMatchObject({
            status: 'daemon_not_configured',
            repairAction: {
                kind: 'setupThisComputer',
            },
        });
    });

    it('flags daemon auth drift when the relay matches but the daemon is not paired', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay-a.example.test/path',
            daemonRelayUrl: 'https://relay-a.example.test/api',
            daemonAccountId: null,
        })).toMatchObject({
            status: 'daemon_needs_auth',
            repairAction: {
                kind: 'setupThisComputer',
            },
        });
    });

    it('flags daemon_not_installed when readiness data says the service is missing', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay-a.example.test/path',
            daemonRelayUrl: 'https://relay-a.example.test/api',
            daemonAccountId: 'acct_1',
            daemonServiceInstalled: false,
        })).toMatchObject({
            status: 'daemon_not_installed',
            repairAction: {
                kind: 'setupThisComputer',
            },
        });
    });

    it('flags daemon_not_running when readiness data says the service exists but the daemon is down', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay-a.example.test/path',
            daemonRelayUrl: 'https://relay-a.example.test/api',
            daemonAccountId: 'acct_1',
            daemonServiceInstalled: true,
            daemonRunning: false,
        })).toMatchObject({
            status: 'daemon_not_running',
            repairAction: {
                kind: 'setupThisComputer',
            },
        });
    });

    it('flags a daemon paired to a different account than the app (F7)', () => {
        // Same relay, healthy service, valid credentials — for someone else's account. The app
        // cannot see that machine's sessions and the gate will not repoint it silently, so with
        // nothing said here the settings row claimed the daemon was "likely alive" and the only
        // thing that re-offered setup was a relaunch.
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay.example.test',
            daemonRelayUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_daemon',
            appAccountId: 'acct_app',
            daemonNeedsAuth: false,
            daemonServiceInstalled: true,
            daemonRunning: true,
        })).toMatchObject({
            status: 'daemon_account_mismatch',
            repairAction: { kind: 'setupThisComputer' },
        });
    });

    it('stays aligned when the app and the daemon are on the same account, or the app has none (F7)', () => {
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay.example.test',
            daemonRelayUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_app',
            appAccountId: 'acct_app',
            daemonNeedsAuth: false,
            daemonServiceInstalled: true,
            daemonRunning: true,
        })).toMatchObject({ status: 'aligned' });

        // Signed out, or a relay whose account the app does not know: nothing to contradict.
        expect(classifyRelayDrift({
            activeRelayUrl: 'https://relay.example.test',
            daemonRelayUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_daemon',
            appAccountId: null,
            daemonNeedsAuth: false,
            daemonServiceInstalled: true,
            daemonRunning: true,
        })).toMatchObject({ status: 'aligned' });
    });
});

describe('resolveKnownRelayEquivalentUrl', () => {
    it('returns the paired local relay url when the active relay matches the daemon public relay', () => {
        expect(resolveKnownRelayEquivalentUrl({
            activeRelayUrl: 'https://relay.example.test',
            daemonRelayUrl: 'http://127.0.0.1:3012',
            daemonAlternateRelayUrls: ['https://relay.example.test'],
        })).toBe('http://127.0.0.1:3012');
    });

    it('returns null when no daemon relay pair matches the active relay', () => {
        expect(resolveKnownRelayEquivalentUrl({
            activeRelayUrl: 'https://relay.example.test',
            daemonRelayUrl: 'https://other.example.test',
            daemonAlternateRelayUrls: ['http://127.0.0.1:3012'],
        })).toBeNull();
    });
});
