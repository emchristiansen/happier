import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

// Settings › This computer only renders on desktop, where the drift summary reads this computer's
// own ambient facts; the platform adapter is the boundary.
vi.mock('@/utils/platform/tauri', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/tauri')>()),
    isTauriDesktop: () => true,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement('Group', { title, footer }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: activeServerSnapshot.serverId, accountId: 'acct_app' }),
}));

// `desktopSetupCoordinator` is a module singleton that reads the app-wide runner. Pointing it at
// each test's bridge keeps the ambient inspection on the same fake boundary as the section.
const runnerRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>();
    return {
        ...actual,
        getSystemTasksRunner: () => runnerRef.current ?? actual.getSystemTasksRunner(),
    };
});

/** What `daemon.service.status.v1` reports on a healthy managed install (Lane B's projection). */
const HEALTHY_AMBIENT_STATUS_DATA = {
    serviceInstalled: true,
    daemonRunning: true,
    needsAuth: false,
    machineId: 'machine-local-1',
    acquisition: { command: '/managed/happier', provenance: 'managed' },
    server: {
        activeServerId: 'relay-example',
        serverUrl: 'https://relay.example.test',
        publicServerUrl: 'https://relay.example.test',
        localServerUrl: null,
        comparableKey: 'relay.example.test',
    },
    auth: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine-local-1',
        needsAuth: false,
        accountId: 'acct_app',
        credentialState: 'valid',
        validatedAccountId: 'acct_app',
    },
    service: { installed: true, running: true },
    daemon: { running: true, startedWithCliVersion: '0.2.13', serviceManaged: true, serviceLabel: 'dev.happier.daemon' },
    runtimeConvergence: {
        controlReachable: true,
        serviceOwnsRunningDaemon: true,
        machineIdMatches: true,
        cliVersionMatches: true,
    },
    // R16 — the executor's one list of this computer's services, and its one completeness signal.
    serviceRows: [
        { relayUrl: 'https://relay.example.test', state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] },
    ],
    pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] },
} as const;

/** Each relay row the way it reads: `title|state|subtitle`. */
function relayRows(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.findAllHostsByTestId('settings.localDaemonControl.relay')
        .map((node) => [node.props.title, node.props.detail, node.props.subtitle ?? ''].join('|'));
}

/**
 * The one ambient read every desktop surface shares (F6). Each case sets what the CLI answers
 * before mounting, because the section no longer runs a status command of its own.
 */
const ambient = { data: HEALTHY_AMBIENT_STATUS_DATA as unknown, fails: false };

/**
 * Lets the one shared inspection settle: a macrotask for the fake bridge's reply, then the effect
 * cycles that publish it and re-render every reader. Both halves matter — asserting after a single
 * turn made the row's facts a race under parallel test load.
 */
async function settleAmbientInspection(): Promise<void> {
    await renderer.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushHookEffects({ cycles: 3, turns: 3 });
}

describe('LocalDaemonControlSection', () => {
    beforeEach(async () => {
        // `desktopSetupCoordinator` memoises one inspection per app open; a fresh module registry
        // gives each case its own instead of the first case's answer.
        vi.resetModules();
        ambient.data = HEALTHY_AMBIENT_STATUS_DATA;
        ambient.fails = false;
        // `desktopSetupCoordinator` is a module singleton holding one ambient-inspection promise.
        // Point it at a bridge that always answers, so the shared inspection settles in every case
        // instead of leaking a pending promise into the next one.
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        runnerRef.current = createSystemTaskRunner({
            bridge: {
                async start() {
                    if (ambient.fails) {
                        throw new Error('daemon status request failed');
                    }
                    return 'ambient:daemon.service.status.v1';
                },
                async subscribe(taskId, listenerSet) {
                    queueMicrotask(() => {
                        listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data: ambient.data });
                    });
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    it('reads the one shared inspection and starts the local daemon service from the control row', async () => {
        // The row starts no status command of its own: it renders the ambient inspection every
        // other desktop surface renders, so the gate, the drift banner and this row cannot
        // describe the same computer differently (F6).
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(starts).toEqual([]);
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
        expect(screen.findByTestId('settings.localDaemonControl.machineId')?.props.subtitle).toBe('machine-local-1');

        await screen.pressByTestIdAsync('settings.localDaemonControl.start');

        expect(starts.some((entry) => (entry as { kind?: unknown }).kind === 'daemon.service.start.v1')).toBe(true);
    });

    it('re-reads this computer once when the section opens, so facts found since app open show (R17)', async () => {
        // The app-open read — the one every desktop surface shares — settled before Settings opened.
        const { desktopSetupCoordinator } = await import('@/setup/desktopSetupCoordinator');
        await desktopSetupCoordinator.inspect();
        // Since then the daily background check found something new (here: the service stopped).
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
    });

    it('re-reads the shared inspection when Refresh is pressed', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();
        // Connected: the row says it all, naming the account it answers as; there is nothing to add.
        expect(relayRows(screen)).toEqual(['relay.example.test|connectionStatus.thisComputerRelayConnected|machine.thisComputer.relayAccount']);
        expect(screen.findByTestId('settings.localDaemonControl.status')).toBeNull();

        // The service stopped while the settings screen was open.
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };
        await screen.pressByTestIdAsync('settings.localDaemonControl.refresh');
        await settleAmbientInspection();

        expect(relayRows(screen)).toEqual(['connectionStatus.thisComputerSetUpFor|connectionStatus.thisComputerRelayOffline|machine.thisComputer.relayAccount']);
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
    });

    it('lists every relay this computer serves, the way the connection popover and the tray list them (C5/A11-07)', async () => {
        // One daemon per relay: the default-following service here, a relay's own service the app
        // installed, and one the person set up themselves — plus one the executor could not read.
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceRows: [
                ...HEALTHY_AMBIENT_STATUS_DATA.serviceRows,
                { relayUrl: 'https://work.example.test', state: 'offline', appManaged: true, serving: 'pinned', actions: ['start'] },
                { relayUrl: 'https://mine.example.test', state: 'needs_attention', appManaged: false, serving: 'pinned', actions: [] },
            ],
            pinnedServices: { complete: false, coexistence: true, services: [], unreadable: [{ relayUrl: 'https://lost.example.test', code: 'invalid_cli_response', message: 'x' }] },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        expect(relayRows(screen)).toEqual([
            'relay.example.test|connectionStatus.thisComputerRelayConnected|machine.thisComputer.relayAccount',
            'connectionStatus.thisComputerSetUpFor|connectionStatus.thisComputerRelayOffline|',
            'mine.example.test|connectionStatus.thisComputerRelayNeedsAttention|settingsDesktop.trayUserOwned',
        ]);
        // Never "that is all of them" while one could not be read (M6).
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('settingsDesktop.trayIncomplete');
    });

    it('names the exact command that updates the command line the person kept, copyable, never run (A11-08)', async () => {
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { command: '/usr/local/bin/happier', provenance: 'override', version: '0.2.10' },
            cli: {
                update: { currentVersion: '0.2.10', latestVersion: '0.2.14', updateAvailable: true, managed: false },
                choice: {
                    mode: 'own',
                    otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: null, updateCommand: 'npm install -g @happier-dev/cli@latest' },
                },
            },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        const row = screen.findByTestId('settings.localDaemonControl.updateKeptCli');
        expect(row?.props.copy).toBe('npm install -g @happier-dev/cli@latest');
        expect(row?.props.onPress).toBeUndefined();
        // The app still never offers to run an update of a CLI it did not install.
        expect(screen.findByTestId('settings.localDaemonControl.updateCli')).toBeNull();
    });

    it('repairs through the one setup executor, never the deleted relay.connectBackgroundService kind', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');
        await renderer.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(starts.some((entry) => (entry as { kind?: unknown }).kind === 'relay.connectBackgroundService.v1')).toBe(false);
        expect(starts).toContainEqual(expect.objectContaining({
            kind: 'setup.thisComputer.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://relay.example.test',
                activeLocalRelayUrl: null,
                expectedAccountId: 'acct_app',
                surface: 'desktop.ui',
            }),
        }));
    });

    it('names the command line by version and offers the one Update when a newer one exists (R17)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { ...HEALTHY_AMBIENT_STATUS_DATA.acquisition, version: '0.2.13' },
            cli: { update: { currentVersion: '0.2.13', latestVersion: '0.2.14', updateAvailable: true, managed: true } },
        };
        const starts: Array<{ kind: string }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push({ kind: parsed.kind });
                    return `task_${starts.length}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliManaged');
        expect(screen.findByTestId('settings.localDaemonControl.updateCli')).toBeTruthy();
        await screen.pressByTestIdAsync('settings.localDaemonControl.updateCli');
        expect(starts).toContainEqual({ kind: 'cli.update.v1' });
    });

    it('names the channel of the command line this computer runs beside its version (R11/RV-9)', async () => {
        // An app of another channel adopts the default channel's CLI (D2), so "Happier 0.2.10" alone
        // could not say why the app's own newer release is not the one answering here.
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { ...HEALTHY_AMBIENT_STATUS_DATA.acquisition, version: '0.2.10', channel: 'stable' },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliManagedOnChannel');
    });

    it('names where a command line the app did not install came from, and offers no Update for it (R17)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { command: '/opt/homebrew/bin/happier', provenance: 'override', version: '0.2.10' },
            cli: { update: { currentVersion: '0.2.10', latestVersion: '0.2.14', updateAvailable: true, managed: false } },
        };
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliFromPath');
        expect(screen.findByTestId('settings.localDaemonControl.updateCli')).toBeNull();
    });

    it('says this computer runs the person\'s own command line, and changes it through the one setup run (R12)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { command: '/usr/local/bin/happier', provenance: 'override', version: '0.2.13' },
            cli: {
                update: null,
                choice: {
                    mode: 'own',
                    otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: 'npm uninstall -g @happier-dev/cli', updateCommand: 'npm install -g @happier-dev/cli@latest' },
                },
            },
        };
        const starts: Array<{ kind: string; params: unknown }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push({ kind: parsed.kind, params: parsed.params });
                    return `task_${starts.length}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliChoiceOwn');
        expect(screen.findByTestId('settings.localDaemonControl.oldCli')).toBeNull();
        await screen.pressByTestIdAsync('settings.localDaemonControl.changeCli');
        await settleAmbientInspection();
        expect(starts).toContainEqual({ kind: 'setup.thisComputer.v1', params: expect.objectContaining({ reconsiderCli: true }) });
    });

    it('says Happier manages the command line and shows, never runs, the command that removes the old copy (R12)', async () => {
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            acquisition: { ...HEALTHY_AMBIENT_STATUS_DATA.acquisition, version: '0.2.14' },
            cli: {
                update: null,
                choice: {
                    mode: 'managed',
                    otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: 'npm uninstall -g @happier-dev/cli', updateCommand: 'npm install -g @happier-dev/cli@latest' },
                },
            },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliChoiceManaged');
        const oldCopy = screen.findByTestId('settings.localDaemonControl.oldCli');
        expect(oldCopy?.props.subtitle).toBe('machine.thisComputer.cliOldCopyRemove');
        expect(oldCopy?.props.copy).toBe('npm uninstall -g @happier-dev/cli');
        expect(screen.findByTestId('settings.localDaemonControl.changeCli')).toBeTruthy();
    });

    it('shows a second CLI behind the managed one even when nobody needed to answer a choice', async () => {
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            cli: {
                update: null,
                choice: {
                    mode: null,
                    otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: 'npm uninstall -g @happier-dev/cli', updateCommand: 'npm install -g @happier-dev/cli@latest' },
                },
            },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        const oldCopy = screen.findByTestId('settings.localDaemonControl.oldCli');
        expect(oldCopy?.props.subtitle).toBe('machine.thisComputer.cliOldCopyRemove');
        expect(oldCopy?.props.copy).toBe('npm uninstall -g @happier-dev/cli');
    });

    it('offers no change when there is no other command line to choose (R12)', async () => {
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            cli: { update: null, choice: { mode: 'managed', otherCli: null } },
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.cli')?.props.subtitle).toBe('machine.thisComputer.cliChoiceManaged');
        expect(screen.findByTestId('settings.localDaemonControl.changeCli')).toBeNull();
        expect(screen.findByTestId('settings.localDaemonControl.oldCli')).toBeNull();
    });

    it('surfaces a recoverable status error without disabling daemon repair', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        ambient.fails = true;

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        // The list could not be read: said in the tray's words, never as an old single-service sentence.
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('settingsDesktop.trayReadFailed');
        expect(screen.findByProps({ subtitle: 'daemon status request failed' })).toBeTruthy();
        expect(screen.findByTestId('settings.localDaemonControl.repair')?.props.disabled).toBe(false);
    });
    it('shows the named reason when Start could not start a service, even though another one started (N3)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    return `task:${SystemTaskSpecSchema.parse(spec).kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    if (taskId === 'task:daemon.service.start.v1') {
                        queueMicrotask(() => listenerSet.onResult({
                            protocolVersion: 1,
                            taskId,
                            ok: true,
                            data: {
                                ...HEALTHY_AMBIENT_STATUS_DATA,
                                targets: [
                                    { target: 'default-following', outcome: 'failed', code: 'daemon_service_not_ready', message: 'Daemon service did not reach a ready state.' },
                                    { target: 'https://relay-b.example.test', outcome: 'started' },
                                ],
                            },
                        }));
                    }
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();
        await screen.pressByTestIdAsync('settings.localDaemonControl.start');
        await settleAmbientInspection();

        expect(screen.findAll((node) => node.props?.subtitle === 'Daemon service did not reach a ready state.').length).toBeGreaterThan(0);
    });
});
