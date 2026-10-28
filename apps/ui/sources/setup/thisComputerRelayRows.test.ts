import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { inspectionFromResult } from './desktopSetupCoordinator';
import { listThisComputerRelayRows } from './thisComputerRelayRows';

const APP_RELAY = 'https://relay.example.com';

function facts(relayUrl: string, validatedAccountId = 'acct_app') {
    return {
        acquisition: { command: '/home/me/.happier/bin/happier', provenance: 'managed' },
        server: { serverUrl: relayUrl, publicServerUrl: relayUrl, localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid', validatedAccountId, accountId: validatedAccountId, machineId: 'machine-1' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
        cli: { update: null, choice: null },
    };
}

/** A status result as the executor sends it, rows included (bootstrap `listThisComputerServiceRows`). */
function inspectionWith(data: Record<string, unknown>) {
    return inspectionFromResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_status', ok: true, data: data as never });
}

const ROWS = [
    { relayUrl: APP_RELAY, state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] },
    { relayUrl: 'https://work.example.com', state: 'offline', appManaged: true, serving: 'pinned', actions: ['start'] },
    { relayUrl: 'https://mine.example.com', state: 'needs_attention', appManaged: false, serving: 'pinned', actions: [] },
];

/** The executor's one completeness signal (`pinnedServices.complete`). */
function pinnedServices(complete: boolean) {
    return { complete, coexistence: true, services: [], unreadable: [] };
}

describe('listThisComputerRelayRows', () => {
    it('renders the executor\'s rows as sent, with who manages each service and what may be done', () => {
        const rows = listThisComputerRelayRows(inspectionWith({ ...facts(APP_RELAY), serviceRows: ROWS, pinnedServices: pinnedServices(false) }), null);
        expect(rows).toEqual({
            status: 'listed',
            complete: false,
            rows: [
                { relayUrl: APP_RELAY, host: 'relay.example.com', state: 'connected', appRelay: false, appManaged: true, actions: ['restart', 'stop'] },
                { relayUrl: 'https://work.example.com', host: 'work.example.com', state: 'offline', appRelay: false, appManaged: true, actions: ['start'] },
                { relayUrl: 'https://mine.example.com', host: 'mine.example.com', state: 'needs_attention', appRelay: false, appManaged: false, actions: [] },
            ],
        });
    });

    it('is whole only when the executor says every service was read; an older result is unknown (M6)', () => {
        const complete = listThisComputerRelayRows(inspectionWith({ ...facts(APP_RELAY), serviceRows: ROWS, pinnedServices: pinnedServices(true) }), null);
        const unknown = listThisComputerRelayRows(inspectionWith({ ...facts(APP_RELAY), serviceRows: ROWS }), null);
        expect(complete.status === 'listed' ? complete.complete : null).toBe(true);
        expect(unknown.status === 'listed' ? unknown.complete : null).toBe(false);
    });

    it('lists one row per relay by its comparable key, not by the host it displays (C9)', () => {
        const rows = listThisComputerRelayRows(inspectionWith({
            ...facts(APP_RELAY),
            serviceRows: [
                ROWS[0],
                // One local relay spelled two ways — the same relay to bootstrap, so one row, though
                // the two spellings display differently.
                { ...ROWS[1], relayUrl: 'http://localhost:3005' },
                { ...ROWS[1], relayUrl: 'http://127.0.0.1:3005' },
                // A relay on the same host over another scheme is another relay: its own row, though
                // it displays alike.
                { ...ROWS[1], relayUrl: 'http://relay.example.com' },
            ],
            pinnedServices: pinnedServices(true),
        }), { relayUrl: APP_RELAY, localRelayUrl: null, accountId: 'acct_app' });
        expect(rows.status === 'listed' ? rows.rows.map((row) => [row.relayUrl, row.appRelay]) : null).toEqual([
            [APP_RELAY, true],
            ['http://localhost:3005', false],
            ['http://relay.example.com', false],
        ]);
    });

    it('judges only the app\'s own relay again, against the account the app is signed in as', () => {
        // The executor saw a converged daemon for its relay's own account; the app is someone else.
        const inspection = inspectionWith({ ...facts(APP_RELAY, 'acct_daemon'), serviceRows: ROWS, pinnedServices: pinnedServices(true) });
        const rows = listThisComputerRelayRows(inspection, { relayUrl: APP_RELAY, localRelayUrl: null, accountId: 'acct_app' });
        expect(rows.status === 'listed' ? rows.rows.map((row) => row.state) : null).toEqual(['needs_attention', 'offline', 'needs_attention']);

        const same = listThisComputerRelayRows(inspectionWith({ ...facts(APP_RELAY, 'acct_app'), serviceRows: ROWS }), { relayUrl: APP_RELAY, localRelayUrl: null, accountId: 'acct_app' });
        expect(same.status === 'listed' ? same.rows[0]?.state : null).toBe('connected');
    });

    it('claims no rows before the inspection settles, after it failed, or when the executor sent none', () => {
        expect(listThisComputerRelayRows({ status: 'pending' }, null)).toEqual({ status: 'pending' });
        expect(listThisComputerRelayRows({ status: 'failed', error: { code: 'x', message: 'y' } }, null)).toEqual({ status: 'failed' });
        expect(listThisComputerRelayRows(inspectionWith(facts(APP_RELAY)), null)).toEqual({ status: 'failed' });
    });

    it('drops a row it cannot read rather than guessing its state', () => {
        const rows = listThisComputerRelayRows(inspectionWith({ ...facts(APP_RELAY), serviceRows: [{ relayUrl: APP_RELAY, state: 'exploded' }, ROWS[1]] }), null);
        expect(rows.status === 'listed' ? rows.rows.map((row) => row.relayUrl) : null).toEqual(['https://work.example.com']);
    });
});
