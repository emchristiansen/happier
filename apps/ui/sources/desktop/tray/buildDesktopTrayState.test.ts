import { describe, expect, it } from 'vitest';

import { buildDesktopTrayState } from './buildDesktopTrayState';

describe('buildDesktopTrayState', () => {
    const translate = ((key: string, params?: { relay?: string; count?: string }) => (params?.relay ? `${key}:${params.relay}` : params?.count ? `${key}:${params.count}` : key)) as never;
    const rest = {
        t: translate,
        services: { status: 'pending' } as const,
        serviceAutostart: null,
        taskParams: { target: { kind: 'local' }, channel: 'stable' },
    };

    it('describes healthy connection health with its machine counts', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            ...rest,
        })).toMatchObject({
            label: 'status.connected',
            detail: 'status.online · 3/3',
        });
    });

    it('describes relay drift as action required even when connection health is healthy', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            ...rest,
        })).toMatchObject({
            label: 'status.actionRequired',
            detail: 'This computer is connected to self.example.test as bob.',
        });
    });

    it('explains "no machines" by what this computer is connected to, instead of the generic hint (U7)', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'no_machine',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'newSession.noMachinesFound',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            ...rest,
        })).toMatchObject({
            label: 'status.actionRequired',
            detail: 'This computer is connected to self.example.test as bob.',
        });
    });

    it('keeps a server-level failure its own description even when this computer has something to say', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_unreachable',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            ...rest,
        })).toMatchObject({ label: 'status.disconnected', detail: 'status.unknown' });
    });

    it('describes action-required health kinds with the canonical status keys', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'machine_offline',
                machineCount: 4,
                onlineCount: 0,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.offline',
            },
            ...rest,
        })).toMatchObject({
            label: 'status.actionRequired',
            detail: 'status.offline · 0/4',
        });
    });

    it('omits machine counts when there are no machines', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_unreachable',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            },
            ...rest,
        })).toMatchObject({
            label: 'status.disconnected',
            detail: 'status.unknown',
        });
    });

    it('carries the one Updates item label only while there is something to act on (R13 (e))', () => {
        const health = {
            kind: 'healthy' as const,
            machineCount: 1,
            onlineCount: 1,
            statusLabelKey: 'status.connected' as const,
            machineLabelKey: 'status.online' as const,
        };
        expect(buildDesktopTrayState({ health, updatesItem: { label: 'Updates available (2)…', enabled: true }, ...rest }))
            .toMatchObject({ updatesLabel: 'Updates available (2)…', updatesEnabled: true });
        // "Updating…" says what is happening; it is not an action.
        expect(buildDesktopTrayState({ health, thisComputerSentence: 'Drift.', updatesItem: { label: 'Updating…', enabled: false }, ...rest }))
            .toMatchObject({ updatesLabel: 'Updating…', updatesEnabled: false });
        expect('updatesLabel' in buildDesktopTrayState({ health, updatesItem: null, ...rest })).toBe(false);
    });

    it('carries every localized menu label, with {relay} left for the native side to fill (U14)', () => {
        const state = buildDesktopTrayState({
            health: { kind: 'healthy', machineCount: 0, onlineCount: 0, statusLabelKey: 'status.connected', machineLabelKey: 'status.online' },
            ...rest,
        });
        expect(state.labels).toMatchObject({
            open: 'settingsDesktop.trayOpen',
            quit: 'settingsDesktop.trayQuit',
            // D11-1 — the native Quit names what it does once the login-start setting is known.
            quitKeepServices: 'settingsDesktop.trayQuitKeepServices',
            quitStopServices: 'settingsDesktop.trayQuitStopServices',
            stopServicesAndQuit: 'settingsDesktop.trayStopAndQuit',
            connected: 'connectionStatus.thisComputerRelayConnected',
            cancel: 'common.cancel',
            stopConfirmTitle: 'settingsDesktop.trayStopConfirmTitle:{relay}',
        });
        expect(state.taskParams).toEqual(rest.taskParams);
        expect(state.serviceAutostart).toBeNull();
    });

    it('hands the native menu one row per relay from the shared projection, and the login-start setting', () => {
        const state = buildDesktopTrayState({
            health: { kind: 'healthy', machineCount: 1, onlineCount: 1, statusLabelKey: 'status.connected', machineLabelKey: 'status.online' },
            ...rest,
            services: {
                status: 'listed',
                complete: false,
                rows: [{ relayUrl: 'https://a.example.com', host: 'a.example.com', state: 'offline', appRelay: false, appManaged: true, actions: ['start'] }],
            },
            serviceAutostart: 'at-login',
        });
        expect(state.services).toEqual({
            status: 'listed',
            complete: false,
            rows: [{ relayUrl: 'https://a.example.com', name: 'a.example.com', state: 'offline', appManaged: true, actions: ['start'] }],
        });
        expect(state.serviceAutostart).toBe('at-login');
    });

    it('says how many agent sessions run on the app relay\'s row, only when the app can see them (R16 c)', () => {
        const services = {
            status: 'listed' as const,
            complete: true,
            rows: [
                { relayUrl: 'https://a.example.com', host: 'a.example.com', state: 'connected' as const, appRelay: true, appManaged: true, actions: ['restart', 'stop'] as const },
                { relayUrl: 'https://b.example.com', host: 'b.example.com', state: 'connected' as const, appRelay: false, appManaged: true, actions: ['restart', 'stop'] as const },
            ],
        };
        const health = { kind: 'healthy' as const, machineCount: 1, onlineCount: 1, statusLabelKey: 'status.connected' as const, machineLabelKey: 'status.online' as const };
        const seen = buildDesktopTrayState({ health, ...rest, services, appRelaySessionCount: 0 });
        expect(seen.services.status === 'listed' ? seen.services.rows.map((row) => row.activeSessionCount) : null).toEqual([0, undefined]);
        // Unseen is unknown, never zero.
        const unseen = buildDesktopTrayState({ health, ...rest, services, appRelaySessionCount: null });
        expect(unseen.services.status === 'listed' ? unseen.services.rows.every((row) => !('activeSessionCount' in row)) : null).toBe(true);
        expect(seen.labels.sessions).toBe('settingsDesktop.traySessions:{count}');
    });
});
