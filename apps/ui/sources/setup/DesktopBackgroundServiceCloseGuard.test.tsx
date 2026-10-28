import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import type { SystemTaskBridge, SystemTaskRunner } from '@/components/systemTasks/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The guard runs on its real owners — the one inspection (`desktopSetupCoordinator`), the service
 * commands (`desktopBackgroundServiceControl`), the quit question (`presentBackgroundServiceCloseConsent`)
 * and the session/machine readers. Only the boundaries are replaced: the native shell (Tauri), the
 * system-task bridge that runs bootstrap, and the modal surface that asks the person.
 */

const state = vi.hoisted(() => ({
    autostart: 'on-demand' as 'at-login' | 'on-demand' | null,
    defaultInstalled: true,
    pinnedMode: undefined as 'at-login' | 'on-demand' | undefined,
    machineId: 'machine-local-1' as string | null,
    /** The account the relay validated the daemon's credentials for (H4). */
    daemonAccountId: 'acct_app' as string | null,
    /** The account the app itself is signed in to on its active relay (H4). */
    appAccountId: 'acct_app' as string | null,
    appRelayUrl: 'https://relay.example.test',
    appLocalRelayUrl: null as string | null,
    runtimeConvergence: {
        controlReachable: true,
        serviceOwnsRunningDaemon: true,
        machineIdMatches: true,
        cliVersionMatches: true,
    },
    inspectionFailed: false,
    finishThrows: false,
    listenThrows: false,
    consentAnswer: 'keep' as 'keep' | 'stop',
    consentThrows: false,
    stopFails: false,
    /** A relay's own service here ("connect to this relay too"), running beside the default one. */
    pinnedRunningElsewhere: false,
    /** The executor's one completeness signal for this computer's services. */
    servicesComplete: true,
    /** A14-02 — the producer's common login-start mode of every managed service (`undefined`: same as the default's). */
    managedAutostart: undefined as 'at-login' | 'on-demand' | null | undefined,
    /** A14-01 — the producer's count of running managed services (`undefined`: what the fixture lists). */
    runningManagedCount: undefined as number | null | undefined,
    runner: null as SystemTaskRunner | null,
    /** Every task bootstrap was asked to run, by kind. */
    started: [] as string[],
    /** Every question and notice put to the person, by title key. */
    alerts: [] as Array<Readonly<{ title: string; message: string }>>,
}));

const invokeTauriMock = vi.hoisted(() => vi.fn(async (command: string, _args?: unknown) => {
    if (command === 'desktop_finish_shutdown' && state.finishThrows) {
        throw new Error('the webview is gone');
    }
    return undefined;
}));
const listeners = vi.hoisted(() => [] as Array<(payload?: unknown) => void>);

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: invokeTauriMock,
    isTauriDesktop: () => true,
    listenTauriEvent: async (_event: string, handler: (payload?: unknown) => void) => {
        if (state.listenThrows) {
            throw new Error('no event system here');
        }
        listeners.push(handler);
        return () => {};
    },
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>()),
    getSystemTasksRunner: () => state.runner,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            // The person's answer: the button they would press, found by its label.
            alertAsync: async (title, message, buttons) => {
                state.alerts.push({ title: String(title), message: String(message ?? '') });
                if (state.consentThrows && title !== 'settingsDesktop.trayActionFailedTitle') {
                    throw new Error('no surface to ask on');
                }
                const label = state.consentAnswer === 'stop' ? 'settingsDesktop.closeStopConfirm' : 'settingsDesktop.closeStopKeep';
                buttons?.find((button) => button.text === label)?.onPress?.();
            },
        },
    }).module;
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (state.appAccountId ? { serverId: 'relay-example', accountId: state.appAccountId } : null),
}));

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>()),
    getActiveServerSnapshot: () => ({
        serverId: 'relay-example',
        serverUrl: state.appRelayUrl,
        activeLocalRelayUrl: state.appLocalRelayUrl,
        generation: 1,
    }),
}));

import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storageStore';

import { DesktopBackgroundServiceCloseGuard } from './DesktopBackgroundServiceCloseGuard';
import { desktopSetupCoordinator } from './desktopSetupCoordinator';

function daemonFacts(serverUrl: string, extra: Record<string, unknown> = {}) {
    return {
        acquisition: { command: '/managed/happier', provenance: 'managed' },
        server: { serverUrl, publicServerUrl: serverUrl, localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid', machineId: state.machineId, validatedAccountId: state.daemonAccountId, accountId: state.daemonAccountId },
        service: { installed: state.defaultInstalled, running: state.defaultInstalled, ...(state.autostart ? { autostart: state.autostart } : {}), targetMode: 'default-following' },
        runtimeConvergence: state.runtimeConvergence,
        ...extra,
    };
}

/** What `daemon.service.status.v1` answers for the case's computer. */
function statusData() {
    const pinned = state.pinnedRunningElsewhere
        ? [{
            ...daemonFacts('https://relay-b.example.test'),
            service: { installed: true, running: true, autostart: state.pinnedMode ?? state.autostart, targetMode: 'pinned' },
            managedBy: 'desktop',
        }]
        : [];
    return {
        ...daemonFacts('https://relay.example.test'),
        pinnedServices: { complete: state.servicesComplete, coexistence: true, services: pinned, unreadable: [] },
        // The status producer's aggregates over every managed service (bootstrap `daemonService.ts`).
        managedServiceAutostart: state.managedAutostart === undefined ? state.autostart : state.managedAutostart,
        runningManagedServiceCount: state.runningManagedCount === undefined
            ? (state.servicesComplete ? Number(state.defaultInstalled) + pinned.length : null)
            : state.runningManagedCount,
        serviceRows: [
            ...(state.defaultInstalled ? [{ relayUrl: 'https://relay.example.test', state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] }] : []),
            ...pinned.map((service) => ({ relayUrl: service.server.serverUrl, state: 'connected', appManaged: true, serving: 'pinned', actions: ['restart', 'stop'] })),
        ],
    };
}

/** The system-task bridge: bootstrap's answers to the status read and the stop command. */
function installBridge(): void {
    const bridge: SystemTaskBridge = {
        async start(spec: SystemTaskSpec) {
            state.started.push(spec.kind);
            return `${spec.kind}:${state.started.length}`;
        },
        async subscribe(taskId, listenerSet) {
            const kind = taskId.split(':')[0];
            queueMicrotask(() => {
                if (kind === 'daemon.service.status.v1' && state.inspectionFailed) {
                    listenerSet.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: { code: 'nope', message: 'nope' } });
                    return;
                }
                if (kind === 'daemon.service.stop.v1' && state.stopFails) {
                    listenerSet.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: { code: 'service_stop_failed', message: 'launchctl could not stop dev.happier.daemon' } });
                    return;
                }
                listenerSet.onResult({
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: (kind === 'daemon.service.status.v1' ? statusData() : {}) as never,
                });
            });
            return () => {};
        },
        async cancel() {},
        async respond() {},
    };
    state.runner = createSystemTaskRunner({ mode: 'dev', bridge });
}

/**
 * This app open's one inspection, settled before the quit (the guard never reads one itself). The
 * coordinator is the app's singleton, so each case re-reads it for that case's computer.
 */
async function establishInspection(): Promise<void> {
    await desktopSetupCoordinator.inspect({ fresh: true });
}

/** Agent sessions the app can see, on the machine each runs on. */
function setSessions(sessions: Record<string, { machineId: string }>, ready = true): void {
    const records = Object.fromEntries(Object.entries(sessions).map(([id, session]) => [
        id,
        { id, active: true, metadata: { machineId: session.machineId, path: '/work', host: 'host' } },
    ]));
    storage.setState({ sessions: records as never, isDataReady: ready } as never);
}

async function mountAndQuit(payload?: unknown): Promise<void> {
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        tree = renderer.create(<DesktopBackgroundServiceCloseGuard enabled />);
    });
    await act(async () => {
        listeners.forEach((listener) => listener(payload));
        await Promise.resolve();
    });
    // Let the handler's awaited chain (the stop command's round trip included) settle.
    for (let turn = 0; turn < 4; turn += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    await act(async () => { tree?.unmount(); });
}

const stops = () => state.started.filter((kind) => kind === 'daemon.service.stop.v1').length;
const consentAsked = () => state.alerts.filter((alert) => alert.title.startsWith('settingsDesktop.closeStop')).length;
const finishedWith = () => invokeTauriMock.mock.calls.filter(([command]) => command === 'desktop_finish_shutdown').map(([, args]) => args ?? null);

describe('DesktopBackgroundServiceCloseGuard', () => {
    beforeEach(() => {
        listeners.length = 0;
        state.autostart = 'on-demand';
        state.defaultInstalled = true;
        state.pinnedMode = undefined;
        state.machineId = 'machine-local-1';
        state.daemonAccountId = 'acct_app';
        state.appAccountId = 'acct_app';
        state.appRelayUrl = 'https://relay.example.test';
        state.appLocalRelayUrl = null;
        state.runtimeConvergence = {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        };
        state.inspectionFailed = false;
        state.finishThrows = false;
        state.listenThrows = false;
        state.consentAnswer = 'keep';
        state.consentThrows = false;
        state.stopFails = false;
        state.pinnedRunningElsewhere = false;
        state.servicesComplete = true;
        state.managedAutostart = undefined;
        state.runningManagedCount = undefined;
        state.started = [];
        state.alerts = [];
        invokeTauriMock.mockClear();
        vi.mocked(Modal.alertAsync).mockClear();
        installBridge();
        setSessions({});
    });

    // These run first, while this app open has established nothing yet: the one inspection is the
    // app's singleton, and once a case below has read it, it stays established for the run.
    it('neither starts nor waits on a local inspection while the exit is held (F9/F7)', async () => {
        // A brand new read here would begin a managed-CLI acquisition, bounded only by the user
        // pressing Quit again — and awaiting the warm-up's in-flight read holds the exit on that
        // same download. The guard decides from what this app open already established; with
        // nothing established, the service is left exactly as it is.
        await mountAndQuit();

        expect(state.started).toEqual([]);
        expect(consentAsked()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('keeps the tray on a quit before this app open read the setting, when the native side knows it starts at login (C8 c)', async () => {
        // Nothing established yet (the first read has not answered): the native side's last known
        // login-start setting decides whether the tray outlives the window; no service is touched.
        await mountAndQuit({ stopServices: false, startAtLogin: true });

        expect(stops()).toBe(0);
        expect(consentAsked()).toBe(0);
        expect(finishedWith()).toEqual([{ outcome: 'menuBar' }]);
    });

    it('follows the native side\'s "on-demand" before the first read, asking since no session is visible yet (N-7)', async () => {
        // The setting is off, so Quit owes the stop; with nothing read yet the app cannot see any
        // session, so it asks — and stops only on "Stop anyway".
        state.consentAnswer = 'keep';
        await mountAndQuit({ stopServices: false, startAtLogin: false });

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopUnknownTitle']);
        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('stops the background service on quit when nothing is running here', async () => {
        await establishInspection();
        await mountAndQuit();

        expect(consentAsked()).toBe(0);
        expect(stops()).toBe(1);
        expect(finishedWith()).toEqual([null]);
    });

    it('asks before ending agent sessions running on this computer, and honours "stop anyway"', async () => {
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentAnswer = 'stop';
        await establishInspection();

        await mountAndQuit();

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopTitle']);
        expect(stops()).toBe(1);
    });

    it('honours "leave it running" and still lets the app quit', async () => {
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentAnswer = 'keep';
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('does not count sessions running on other computers', async () => {
        setSessions({ a: { machineId: 'machine-somewhere-else' } });
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(0);
        expect(stops()).toBe(1);
    });

    it('leaves the service running when the question cannot be put to anyone', async () => {
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentThrows = true;
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('asks before the aggregate stop ends sessions it cannot see on another relay\'s running service (N-2)', async () => {
        // On-demand stops every app-managed service, but the app sees only its own relay's sessions:
        // a running "Connect … too" service elsewhere may have work the app never saw.
        state.pinnedRunningElsewhere = true;
        state.consentAnswer = 'keep';
        await establishInspection();

        await mountAndQuit();

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopUnknownTitle']);
        expect(stops()).toBe(0);
    });

    it('asks when the producer counts running managed services beyond the one whose sessions it sees (A14-01)', async () => {
        // The rows show only the app relay, but bootstrap counts two running managed services.
        state.runningManagedCount = 2;
        state.consentAnswer = 'keep';
        await establishInspection();

        await mountAndQuit();

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopUnknownTitle']);
        expect(stops()).toBe(0);
    });

    it('follows the managed services\' common login-start mode, not the default service\'s own (A14-02)', async () => {
        // An absent default's stale mode is on-demand; the installed managed pin starts at login.
        state.defaultInstalled = false;
        state.pinnedRunningElsewhere = true;
        state.pinnedMode = 'at-login';
        state.managedAutostart = 'at-login';
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([{ outcome: 'menuBar' }]);
    });

    it('treats managed services that disagree on login start as unknown: quit, touching nothing (A14-02)', async () => {
        state.autostart = 'at-login';
        state.managedAutostart = null;
        state.pinnedRunningElsewhere = true;
        state.pinnedMode = 'on-demand';
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('asks when the list of this computer\'s services is not whole (N-2)', async () => {
        state.servicesComplete = false;
        state.consentAnswer = 'stop';
        await establishInspection();

        await mountAndQuit();

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopUnknownTitle']);
        expect(stops()).toBe(1);
    });

    it('never stops a service that starts at login: Quit keeps the tray instead (R16 a)', async () => {
        state.autostart = 'at-login';
        setSessions({ a: { machineId: 'machine-local-1' } });
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(0);
        expect(stops()).toBe(0);
        expect(invokeTauriMock).not.toHaveBeenCalledWith('desktop_show_main_window');
        expect(finishedWith()).toEqual([{ outcome: 'menuBar' }]);
    });

    it('quits outright, leaving the service as it is, when the login-start mode is unknown', async () => {
        state.autostart = null;
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('"Stop background services and quit" stops them even when they start at login (R16 c)', async () => {
        state.autostart = 'at-login';
        await establishInspection();

        await mountAndQuit({ stopServices: true });

        expect(stops()).toBe(1);
        expect(finishedWith()).toEqual([null]);
    });

    it('"Stop background services and quit" still asks before ending sessions running here', async () => {
        state.autostart = 'on-demand';
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentAnswer = 'keep';
        await establishInspection();

        await mountAndQuit({ stopServices: true });

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopTitle']);
        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('keeps the tray when the person keeps services that start at login running (C8 a)', async () => {
        // "Stop background services and quit", then "Leave it running": the services keep running
        // and start at login, which is exactly what the tray is kept for (R16 a).
        state.autostart = 'at-login';
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentAnswer = 'keep';
        await establishInspection();

        await mountAndQuit({ stopServices: true });

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([{ outcome: 'menuBar' }]);
    });

    it('stays in the tray and says so when the services could not be stopped (C8 b / A11-03)', async () => {
        state.stopFails = true;
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(1);
        // Said in a window the person can see, with bootstrap's own reason, never swallowed.
        const shownAt = invokeTauriMock.mock.calls.findIndex(([command]) => command === 'desktop_show_main_window');
        expect(shownAt).toBeGreaterThanOrEqual(0);
        expect(state.alerts).toEqual([{
            title: 'settingsDesktop.trayActionFailedTitle',
            message: 'settingsDesktop.closeStopFailedBody\n\nlaunchctl could not stop dev.happier.daemon',
        }]);
        // Not an exit: the services it could not stop stay visible in the tray, and Quit can be retried.
        expect(finishedWith()).toEqual([{ outcome: 'menuBar' }]);
    });

    it('brings the window back before asking, so the question is not put to a hidden webview (H5)', async () => {
        // Quit from the tray never shows the window. Asking there held the exit on a modal nobody
        // could see: Quit appeared to do nothing, and a second Quit left the service running.
        setSessions({ a: { machineId: 'machine-local-1' } });
        state.consentAnswer = 'stop';
        await establishInspection();

        await mountAndQuit();

        const shownAt = invokeTauriMock.mock.invocationCallOrder[
            invokeTauriMock.mock.calls.findIndex(([command]) => command === 'desktop_show_main_window')
        ];
        expect(shownAt).toBeDefined();
        expect(shownAt).toBeLessThan(vi.mocked(Modal.alertAsync).mock.invocationCallOrder[0] ?? 0);
    });

    it('never shows the window when nothing is being asked (H5)', async () => {
        await establishInspection();

        await mountAndQuit();

        expect(invokeTauriMock).not.toHaveBeenCalledWith('desktop_show_main_window');
        expect(stops()).toBe(1);
    });

    it('asks when the daemon is paired to another account than the app (H4)', async () => {
        // The app's session store only holds its own relay and account, so it cannot see what this
        // daemon is running. Stopping it would end agent sessions nobody was asked about.
        state.daemonAccountId = 'acct_other';
        await establishInspection();

        await mountAndQuit();

        expect(state.alerts.map((alert) => alert.title)).toEqual(['settingsDesktop.closeStopUnknownTitle']);
        expect(stops()).toBe(0);
    });

    it('asks when the app is on another relay even if the account id is the same', async () => {
        state.appRelayUrl = 'https://other-relay.example.test';
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(1);
        expect(stops()).toBe(0);
    });

    it('asks while the active relay session snapshot has not loaded', async () => {
        setSessions({}, false);
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(1);
        expect(stops()).toBe(0);
    });

    it('asks when the inspection cannot identify the running daemon machine', async () => {
        state.machineId = null;
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(1);
        expect(stops()).toBe(0);
    });

    it('asks when the service does not own the daemon whose sessions the app can see', async () => {
        state.runtimeConvergence = { ...state.runtimeConvergence, serviceOwnsRunningDaemon: false };
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(1);
        expect(stops()).toBe(0);
    });

    it('asks when the app has no account of its own to compare (H4)', async () => {
        state.appAccountId = null;
        await establishInspection();

        await mountAndQuit();

        expect(consentAsked()).toBe(1);
    });

    it('survives a quit the native side cannot finish', async () => {
        // The webview is being torn down around this handler; a rejected invoke must not become an
        // unhandled rejection.
        state.finishThrows = true;
        await establishInspection();

        await mountAndQuit();

        expect(finishedWith()).toEqual([null]);
    });

    it('survives an event subscription that cannot be established', async () => {
        state.listenThrows = true;

        await act(async () => {
            renderer.create(<DesktopBackgroundServiceCloseGuard enabled />);
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

        expect(listeners).toHaveLength(0);
    });

    it('leaves the service running when the local inspection could not say', async () => {
        state.inspectionFailed = true;
        await establishInspection();

        await mountAndQuit();

        expect(stops()).toBe(0);
        expect(finishedWith()).toEqual([null]);
    });

    it('does nothing at all on a non-desktop mount', async () => {
        await act(async () => {
            renderer.create(<DesktopBackgroundServiceCloseGuard enabled={false} />);
        });

        expect(listeners).toHaveLength(0);
    });
});
