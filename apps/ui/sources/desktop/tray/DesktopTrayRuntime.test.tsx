import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { sync } from '@/sync/sync';

const isTauriDesktopState = vi.hoisted(() => ({ value: false }));
/**
 * The native shell (Tauri) is the boundary: `desktop_set_tray_state` receives the tray push and
 * answers the destination a tray item asked for (N-17 — the push adapter itself stays real), and
 * every event this webview listens for is captured so a case can deliver it.
 */
const native = vi.hoisted(() => ({
    pushes: [] as unknown[],
    nextDestination: [] as (string | null)[],
    listeners: new Map<string, Set<(payload: unknown) => void>>(),
}));
const invokeTauri = vi.hoisted(() => vi.fn(async (command: string, args?: unknown): Promise<unknown> => {
    if (command !== 'desktop_set_tray_state') return null;
    native.pushes.push((args as { state: unknown }).state);
    return native.nextDestination.shift() ?? null;
}));
function emitNative(event: string, payload: unknown): void {
    for (const listener of Array.from(native.listeners.get(event) ?? [])) listener(payload);
}
/** The last tray state pushed to the native menu. */
function lastPush(): unknown {
    return native.pushes[native.pushes.length - 1];
}

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        isTauriDesktop: () => isTauriDesktopState.value,
        invokeTauri,
        listenTauriEvent: async (event: string, handler: (payload: unknown) => void) => {
            const set = native.listeners.get(event) ?? new Set();
            set.add(handler);
            native.listeners.set(event, set);
            return () => set.delete(handler);
        },
    };
});


vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});


// Adapt the production lazy CommonJS loader to Vitest's module loader, not the singleton's logic.
// Connection switching and settings application both retain the real Sync instance.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => sync }));
// Native credential persistence is empty; retain TokenStorage and the connection owner above it.
// Uses the same SDK boundary shape as tokenStorage.testHelpers without changing renderer platform.
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
} }));

// The system-task bridge (bootstrap) is the boundary under the one inspection owner: every status
// read is counted and answered at once, so a demand that starts a read is observable.
const statusReads = vi.hoisted(() => ({ count: 0, data: {} as Record<string, unknown> }));
vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>();
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    const runner = createSystemTaskRunner({
        bridge: {
            async start(spec) {
                if (spec.kind === 'daemon.service.status.v1') statusReads.count += 1;
                return `${spec.kind}:${statusReads.count}`;
            },
            async subscribe(taskId, listeners) {
                queueMicrotask(() => listeners.onResult({ protocolVersion: 1, taskId, ok: true, data: statusReads.data }));
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
    return { ...actual, getSystemTasksRunner: () => runner };
});

describe('DesktopTrayRuntime', () => {
    beforeEach(async () => {
        const { serverId, serverUrl } = getActiveServerSnapshot();
        statusReads.data = {
            acquisition: { command: '/managed/happier', provenance: 'managed' },
            server: { serverUrl },
            auth: { credentialState: 'valid' },
            service: { installed: false, running: false, autostart: 'at-login', targetMode: 'default-following' },
            managedServiceAutostart: null,
            pinnedServices: { complete: true, services: [], unreadable: [] },
            serviceRows: [],
        };
        storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null });
        storage.getState().applyMachines([
            createMachineFixture({ id: 'tray-1', active: true, activeAt: Date.now() }),
            createMachineFixture({ id: 'tray-2', active: true, activeAt: Date.now() }),
        ], true, { sourceServerId: serverId });
        await desktopSetupCoordinator.inspect({ fresh: true });
    });
    afterEach(() => {
        isTauriDesktopState.value = false;
        native.pushes = [];
        native.nextDestination = [];
        native.listeners.clear();
        invokeTauri.mockClear();
    });

    it('pushes the canonical connection health state into the desktop tray bridge when running in Tauri', async () => {
        isTauriDesktopState.value = true;

        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(lastPush()).toEqual(expect.objectContaining({
            label: 'status.connected',
            detail: 'status.online · 2/2',
            labels: expect.objectContaining({ open: 'settingsDesktop.trayOpen', quit: 'settingsDesktop.trayQuit' }),
            // The one spec builder's params, replayed natively in menu-bar mode (R16 c).
            taskParams: expect.objectContaining({ target: { kind: 'local' } }),
        }));

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not invoke the tray bridge outside the Tauri desktop shell', async () => {
        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(native.pushes).toEqual([]);
        expect(native.listeners.size).toBe(0);

        await act(async () => {
            tree.unmount();
        });
    });

    it('pushes the producer mode and rows for a pin-only installation, then clears a resolved unknown mode', async () => {
        isTauriDesktopState.value = true;
        statusReads.data.managedServiceAutostart = 'on-demand';
        statusReads.data.serviceRows = [{ relayUrl: 'https://pin.example.test', state: 'offline', appManaged: true, serving: 'pinned', actions: ['start'] }];
        statusReads.data.pinnedServices = { complete: true, services: [{
            acquisition: { command: '/managed/happier', provenance: 'managed' },
            server: { serverUrl: 'https://pin.example.test' },
            service: { installed: true, running: false, autostart: 'on-demand', targetMode: 'pinned' },
            managedBy: 'desktop',
        }], unreadable: [] };
        await desktopSetupCoordinator.inspect({ fresh: true });
        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        const screen = await renderScreen(<DesktopTrayRuntime />);
        expect(lastPush()).toMatchObject({ serviceAutostart: 'on-demand', services: { status: 'listed', rows: [{ relayUrl: 'https://pin.example.test', appManaged: true }] } });
        statusReads.data.service = { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' };
        statusReads.data.managedServiceAutostart = null;
        await act(async () => { emitNative('desktop_background_services_changed', null); });
        await vi.waitFor(() => expect(lastPush()).toMatchObject({ serviceAutostart: null }));
        await act(async () => screen.tree.unmount());
    });

    it('describes relay drift as action required even when connection health is healthy', async () => {
        isTauriDesktopState.value = true;
        statusReads.data.server = { serverUrl: 'https://other-relay.example.test' };
        statusReads.data.service = { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' };
        statusReads.data.runtimeConvergence = { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true };
        statusReads.data.managedServiceAutostart = 'at-login';
        await desktopSetupCoordinator.inspect({ fresh: true });

        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(lastPush()).toEqual(expect.objectContaining({
            label: 'status.actionRequired',
            detail: 'server.relayDrift.connectedElsewhere',
        }));

        await act(async () => {
            tree.unmount();
        });
    });

    it('treats a tray row\'s Open as the person picking that relay, through the one direct-selection owner (D11-3)', async () => {
        isTauriDesktopState.value = true;
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `tray_relay_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            // Saved from a link: picking it from the tray must not rewrite where it came from (N-11).
            const work = profiles.upsertServerProfile({ serverUrl: 'https://work.example.com', name: 'Work', source: 'url' });
            const workId = profiles.resolveServerProfileScopeId(work);
            // The window was rebuilt from menu-bar mode by that row's Open.
            native.nextDestination.push('relay:https://WORK.example.com/');

            const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
            const tree = (await renderScreen(<DesktopTrayRuntime />)).tree;
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

            expect(profiles.getActiveServerSnapshot().serverId).toBe(workId);
            expect(profiles.getServerProfileById(work.id)?.source).toBe('url');
            expect(storage.getState().settings.serverSelectionActiveTargetId).toBe(workId);
            // Armed as a direct pick, so the setup gate treats it as the person's choice (R8/INV7).
            const { consumeDirectRelaySelectionIntent } = await import('@/setup/directRelaySelectionIntent');
            expect(consumeDirectRelaySelectionIntent(workId)).toBe(true);
            expect(routerPush).not.toHaveBeenCalled();

            await act(async () => {
                tree.unmount();
            });
        } finally {
            process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('picks a relay this computer serves even when the app has not saved it yet (A12-02)', async () => {
        isTauriDesktopState.value = true;
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `tray_unsaved_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            expect(profiles.listServerProfiles().some((profile) => profile.serverUrl.includes('lab.example.com'))).toBe(false);
            native.nextDestination.push('relay:https://lab.example.com');

            const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
            const tree = (await renderScreen(<DesktopTrayRuntime />)).tree;
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

            // Registered through the profile owner, then picked through the direct-selection owner.
            const lab = profiles.listServerProfiles().find((profile) => profile.serverUrl === 'https://lab.example.com');
            expect(lab).toBeDefined();
            const labId = profiles.resolveServerProfileScopeId(lab!);
            expect(profiles.getActiveServerSnapshot().serverId).toBe(labId);
            const { consumeDirectRelaySelectionIntent } = await import('@/setup/directRelaySelectionIntent');
            expect(consumeDirectRelaySelectionIntent(labId)).toBe(true);

            await act(async () => {
                tree.unmount();
            });
        } finally {
            process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('picks the relay a tray row\'s Open names while this window is open (desktop_open_relay_requested)', async () => {
        isTauriDesktopState.value = true;
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `tray_event_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
            const tree = (await renderScreen(<DesktopTrayRuntime />)).tree;
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

            await act(async () => {
                emitNative('desktop_open_relay_requested', { relayUrl: 'https://team.example.com' });
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            const team = profiles.listServerProfiles().find((profile) => profile.serverUrl === 'https://team.example.com');
            expect(team).toBeDefined();
            expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeId(team!));
            await act(async () => {
                tree.unmount();
            });
        } finally {
            process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('re-reads this computer when the native tray asks for current rows (desktop_tray_refresh_requested)', async () => {
        isTauriDesktopState.value = true;
        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        const tree = (await renderScreen(<DesktopTrayRuntime />)).tree;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        const before = statusReads.count;

        await act(async () => {
            emitNative('desktop_tray_refresh_requested', { trigger: 'tray-pointer' });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(statusReads.count).toBe(before + 1);
        await act(async () => {
            tree.unmount();
        });
    });

    it('opens the screen a tray item asked for while this window was being rebuilt (menu-bar mode)', async () => {
        isTauriDesktopState.value = true;
        native.nextDestination.push('settings');

        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        const tree = (await renderScreen(<DesktopTrayRuntime />)).tree;
        await act(async () => { await Promise.resolve(); });

        expect(routerPush).toHaveBeenCalledWith('/settings');

        await act(async () => {
            tree.unmount();
        });
        routerPush.mockClear();
    });
});
