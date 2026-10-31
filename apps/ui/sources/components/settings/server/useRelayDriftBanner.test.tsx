import * as React from 'react';
import renderer from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemTaskBridge, SystemTaskRunner } from '@/components/systemTasks/types';
import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './hooks/serverSettingsHooksTestHelpers';
import type { RelayDriftBanner } from './relayDriftTypes';

type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
    activeLocalRelayUrl?: string | null;
    generation: number;
}>;

type CachedDoctorSnapshot = Readonly<{
    cachedAt: number;
    snapshot: {
        capturedAt: string;
        server: {
            activeServerId: string;
            serverUrl: string;
            publicServerUrl: string;
            webappUrl: string;
        };
        accountId: string | null;
        settings: {
            activeServerId: string | null;
            servers: readonly [];
            knownAccountIds: readonly string[];
        };
    };
}> | null;

const state = vi.hoisted(() => ({
    activeServerSnapshot: {
        serverId: 'server-a',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    } as ActiveServerSnapshot,
    cachedDoctorSnapshot: null as CachedDoctorSnapshot,
    profiles: [
        {
            id: 'server-a',
            name: 'Relay A',
            serverUrl: 'https://relay.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        },
    ],
    runner: null as SystemTaskRunner | null,
    isTauriDesktop: false,
    accountId: 'acct_app' as string | null,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => state.isTauriDesktop,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (state.accountId ? { serverId: state.activeServerSnapshot.serverId, accountId: state.accountId } : null),
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => state.runner,
}));

/**
 * The real bridge always settles a status read — with facts, or with the failure hsetup reported.
 * These repair fakes only model the setup task, so their status reads (the coordinator re-reads
 * facts that could not see this computer's account before deciding, D1) answer "could not read
 * this computer", which leaves the doctor-cache classification these cases exercise in charge.
 */
function withStatusReadsAnswered(bridge: SystemTaskBridge): SystemTaskBridge {
    let reads = 0;
    return {
        ...bridge,
        start: async (spec) => (spec.kind === 'daemon.service.status.v1' ? `status_read_${++reads}` : await bridge.start(spec)),
        subscribe: async (taskId, listenerSet) => {
            if (!taskId.startsWith('status_read_')) return await bridge.subscribe(taskId, listenerSet);
            queueMicrotask(() => listenerSet.onResult({
                protocolVersion: 1,
                taskId,
                ok: false,
                error: { code: 'cli_spawn_failed', message: 'this computer is not readable in this test' },
            }));
            return () => {};
        },
    };
}

function setupSpecMatcher(target: Readonly<{ activeRelayUrl: string; activeWebappUrl: string; activeLocalRelayUrl: string | null }>) {
    return expect.objectContaining({
        kind: 'setup.thisComputer.v1',
        params: expect.objectContaining({
            ...target,
            expectedAccountId: 'acct_app',
            surface: 'desktop.ui',
        }),
    });
}

const AMBIENT_STATUS_DATA = {
    serviceInstalled: false,
    daemonRunning: false,
    needsAuth: true,
    machineId: null,
    acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
    server: { activeServerId: 'cloud', serverUrl: null, publicServerUrl: null, localServerUrl: null, comparableKey: null },
    auth: {
        authenticated: false,
        machineRegistered: false,
        machineId: null,
        needsAuth: true,
        accountId: null,
        credentialState: 'missing',
        validatedAccountId: null,
    },
    service: { installed: false, running: false },
    daemon: { running: false, startedWithCliVersion: null, serviceManaged: null, serviceLabel: null },
    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
};

/**
 * The one move question (N1): a repair that would take this computer off the relay its service
 * serves asks Move / Keep. `moveAnswer` is what the person presses; unset, the alert is dismissed
 * (the presenter's "keep").
 */
const modalAnswers = vi.hoisted(() => ({ moveAnswer: null as string | null }));

installServerSettingsHooksCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: async (_title, _body, buttons) => {
                    buttons?.find((button) => button.text === modalAnswers.moveAnswer)?.onPress?.();
                },
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
        });
    },
});

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => 'machine-1',
}));

vi.mock('@/components/settings/systemStatus/cache/machineDoctorSnapshotCache', () => ({
    readCachedMachineDoctorSnapshot: () => state.cachedDoctorSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (leftRaw: unknown, rightRaw: unknown) => {
        const left = String(leftRaw ?? '').trim();
        const right = String(rightRaw ?? '').trim();
        if (!left || !right) return false;
        if (left === right) return true;
        const leftProfile = state.profiles.find((profile) => profile.id === left || (profile as { serverIdentityId?: string }).serverIdentityId === left) ?? null;
        const rightProfile = state.profiles.find((profile) => profile.id === right || (profile as { serverIdentityId?: string }).serverIdentityId === right) ?? null;
        return Boolean(leftProfile && rightProfile && leftProfile.id === rightProfile.id);
    },
    getActiveServerSnapshot: () => state.activeServerSnapshot,
    getDeviceDefaultServerId: () => state.activeServerSnapshot.serverId,
    getTabActiveServerId: () => null,
    // Mirrors the real owner: the page origin, except inside the desktop app whose page is its bundle.
    getWebSameOriginServerUrl: () => (state.isTauriDesktop
        ? null
        : (globalThis as { location?: { origin?: string } }).location?.origin ?? null),
    listServerProfiles: () => state.profiles,
}));

const upsertAndActivateServerSpy = vi.hoisted(() => vi.fn((..._args: any[]) => ({ id: 'server-daemon', serverUrl: 'https://daemon-relay.example.test' })));
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        upsertAndActivateServer: (...args: unknown[]) => upsertAndActivateServerSpy(...args),
    };
});

const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: (...args: unknown[]) => switchConnectionToActiveServerSpy(...args),
}));

const refreshFromActiveServerSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: (...args: unknown[]) => refreshFromActiveServerSpy(...args) }),
}));

vi.mock('@/components/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks')>();
    return {
        ...actual,
        getDefaultSystemTaskRunner: () => state.runner,
    };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useRelayDriftBanner', () => {
    beforeEach(() => {
        vi.resetModules();
        Reflect.deleteProperty(globalThis as { location?: unknown }, 'location');
        state.isTauriDesktop = false;
        state.accountId = 'acct_app';
        modalAnswers.moveAnswer = null;
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = null;
        state.profiles = [
            {
                id: 'server-a',
                name: 'Relay A',
                serverUrl: 'https://relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            },
        ];
        state.runner = {
            mode: 'dev',
            start: async () => 'task_1',
            cancel: async () => {},
            respond: async () => {},
            getSnapshot: () => null,
            subscribe: () => () => {},
        } satisfies SystemTaskRunner;
    });

    /** Answers the one ambient `daemon.service.status.v1` read the desktop banner classifies. */
    async function installAmbientLocalFacts(data: unknown): Promise<void> {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: async () => 'task_status',
                async subscribe(taskId, listenerSet) {
                    queueMicrotask(() => listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data }));
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        state.cachedDoctorSnapshot = null;
    }

    /** Ambient facts for a computer that does have a daemon: paired, with a service or a live one. */
    function localFactsForDaemon(params: Readonly<{
        serverUrl: string;
        serviceInstalled: boolean;
        controlReachable: boolean;
    }>) {
        return {
            ...AMBIENT_STATUS_DATA,
            serviceInstalled: params.serviceInstalled,
            daemonRunning: params.controlReachable,
            needsAuth: false,
            machineId: 'machine-1',
            server: { activeServerId: 'server-a', serverUrl: params.serverUrl, publicServerUrl: params.serverUrl, localServerUrl: null, comparableKey: params.serverUrl },
            auth: {
                authenticated: true,
                machineRegistered: true,
                machineId: 'machine-1',
                needsAuth: false,
                accountId: 'acct_app',
                credentialState: 'valid',
                validatedAccountId: 'acct_app',
            },
            service: { installed: params.serviceInstalled, running: params.controlReachable },
            runtimeConvergence: {
                controlReachable: params.controlReachable,
                serviceOwnsRunningDaemon: params.serviceInstalled && params.controlReachable,
                machineIdMatches: params.controlReachable,
                cliVersionMatches: params.controlReachable,
            },
        };
    }

    it('does not show drift when the daemon public relay matches the active relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('does not show drift when the active relay is public but the app same-origin matches the daemon local relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'http://127.0.0.1:3000' },
        } as PropertyDescriptor);
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: '',
                    webappUrl: 'http://127.0.0.1:3000',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('dispatches the relay repair system task when the action is pressed', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });
        const cancelMock = vi.fn(async (_taskId: string) => {});
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: withStatusReadsAnswered({
                start: startMock,
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                cancel: cancelMock,
                respond: async () => {},
            }),
        });
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        if (!resolvedBanner) {
            throw new Error('Expected a relay drift banner');
        }
        await renderer.act(async () => {
            await resolvedBanner.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(setupSpecMatcher({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
        }));
        const bannerAfterStart = banner as RelayDriftBanner | null;
        expect(bannerAfterStart?.repairTaskSnapshot).toEqual(expect.objectContaining({
            taskId: 'task_1',
            status: 'running',
        }));

        await renderer.act(async () => {
            listeners.get('task_1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'progress',
                stepId: 'setup.thisComputer.configureRelay',
                message: 'executor message',
            });
        });

        const bannerAfterEvent = banner as RelayDriftBanner | null;
        expect(bannerAfterEvent?.repairTaskSnapshot).toEqual(expect.objectContaining({
            currentStepId: 'setup.thisComputer.configureRelay',
            latestMessage: 'executor message',
        }));
        expect(typeof bannerAfterEvent?.onCancelRepair).toBe('function');

        await renderer.act(async () => {
            await bannerAfterEvent?.onCancelRepair?.();
        });

        expect(cancelMock).toHaveBeenCalledWith('task_1');
    });

    it('keeps an executor start failure visible instead of making the action appear inert', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const startMock = vi.fn(async (spec: unknown) => {
            const kind = (spec as { kind?: string }).kind;
            if (kind === 'daemon.service.status.v1') {
                return 'status_read_1';
            }
            throw new Error('setup bridge failed');
        });
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: withStatusReadsAnswered({
                start: startMock,
                async subscribe() { return () => {}; },
                async cancel() {},
                async respond() {},
            }),
        });
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: { activeServerId: 'server-a', serverUrl: '', publicServerUrl: '', webappUrl: '' },
                accountId: null,
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect((banner as RelayDriftBanner | null)?.actionHint).toBe('settings.systemTaskStartFailed');
    });

    it('infers the active webapp url when repairing Happier Cloud relay drift', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });

        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: withStatusReadsAnswered({
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            }),
        });
        state.activeServerSnapshot = {
            serverId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'cloud',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'cloud',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).not.toBeNull();
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(setupSpecMatcher({
            activeRelayUrl: 'https://api.happier.dev',
            activeWebappUrl: 'https://cloud.happier.dev',
            activeLocalRelayUrl: null,
        }));
    });

    it('prefers the active snapshot local relay url when available', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });

        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: withStatusReadsAnswered({
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            }),
        });
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3000',
            generation: 2,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-b',
                    serverUrl: 'https://other-relay.example.test',
                    publicServerUrl: 'https://other-relay.example.test',
                    webappUrl: 'https://other-relay.example.test',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-b',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).not.toBeNull();
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(setupSpecMatcher({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3000',
        }));
    });

    it('sends the app relay to the executor, never a relay derived from the daemon', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: withStatusReadsAnswered({
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            }),
        });
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: null,
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(setupSpecMatcher({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
        }));
    });

    it('marks the repair action unavailable when the system task bridge is unavailable', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const startMock = vi.fn(async () => 'task_1');
        state.runner = {
            mode: 'unavailable',
            start: startMock,
            cancel: async () => {},
            respond: async () => {},
            getSnapshot: () => null,
            subscribe: () => () => {},
        } satisfies SystemTaskRunner;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        expect(resolvedBanner?.actionDisabled).toBe(true);
        expect(resolvedBanner?.actionHint).toBe('settings.systemTaskBridgeUnavailable');

        await renderer.act(async () => {
            await resolvedBanner?.onPress();
        });

        expect(startMock).not.toHaveBeenCalled();
    });

    it('is null on a first-run desktop machine about which the app has no daemon knowledge (R10)', async () => {
        state.isTauriDesktop = true;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: { activeServerId: 'server-a', serverUrl: '', publicServerUrl: '', webappUrl: '' },
                accountId: null,
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('stays null once the ambient facts resolve with no daemon on this computer at all (R10)', async () => {
        // "This computer has no daemon yet" is an ordinary first-run fact, not drift: the setup
        // gate owns acquiring it. The CLI config file's default relay is not knowledge of a daemon.
        state.isTauriDesktop = true;
        await installAmbientLocalFacts({
            ...AMBIENT_STATUS_DATA,
            server: { activeServerId: 'server-a', serverUrl: 'https://relay.example.test', publicServerUrl: 'https://relay.example.test', localServerUrl: null, comparableKey: 'https://relay.example.test' },
        });
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toBeNull();
    });

    it('still warns and offers repair when a live local daemon is on a different relay', async () => {
        state.isTauriDesktop = true;
        await installAmbientLocalFacts(localFactsForDaemon({
            serverUrl: 'https://daemon-relay.example.test',
            serviceInstalled: true,
            controlReachable: true,
        }));
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toEqual(expect.objectContaining({
            kind: 'warning',
            title: 'server.relayDrift.bannerDifferentRelayTitle',
            actionLabel: 'server.relayDrift.connectHereAction',
            secondaryActionLabel: 'server.switchToServer',
        }));
    });

    /**
     * One daemon per relay: after "Connect to … too" this computer answers on the app's relay
     * through that relay's own pinned service while the default-following one stays on the other
     * relay. That is connected, not drift — switching relays must not prompt to move.
     */
    it('is null when the app relay has its own pinned service here, whichever relay the default-following one serves', async () => {
        const elsewhere = localFactsForDaemon({ serverUrl: 'https://daemon-relay.example.test', serviceInstalled: true, controlReachable: true });
        const pinnedHere = {
            ...localFactsForDaemon({ serverUrl: 'https://relay.example.test', serviceInstalled: true, controlReachable: true }),
            service: { installed: true, running: true, targetMode: 'pinned' },
            managedBy: 'desktop',
        };
        const read = await renderDesktopBanner({
            ...elsewhere,
            pinnedServices: { complete: true, coexistence: true, services: [pinnedHere], unreadable: [] },
            // Bootstrap's row for the app relay: its own pinned service serves it (D11-2).
            serviceRows: [{ relayUrl: 'https://relay.example.test', state: 'connected', appManaged: true, serving: 'pinned', actions: ['restart', 'stop'] }],
        });

        expect(read()).toBeNull();
    });

    it('still warns and offers repair when this computer has a background service that is not running', async () => {
        // An installed service that no longer answers is daemon knowledge and a real deviation,
        // unlike a computer that never had one.
        state.isTauriDesktop = true;
        await installAmbientLocalFacts(localFactsForDaemon({
            serverUrl: 'https://relay.example.test',
            serviceInstalled: true,
            controlReachable: false,
        }));
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toEqual(expect.objectContaining({
            kind: 'warning',
            title: 'server.relayDrift.bannerNotRunningTitle',
            actionLabel: 'server.relayDrift.connectHereAction',
        }));
    });

    it('classifies desktop-local drift from the ambient local facts, not the remote doctor cache', async () => {
        state.isTauriDesktop = true;
        await installAmbientLocalFacts(localFactsForDaemon({
            serverUrl: 'https://daemon-relay.example.test',
            serviceInstalled: true,
            controlReachable: true,
        }));
        // An aligned remote snapshot: reading it instead of the local facts would report no drift.
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://relay.example.test',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: 'acct_app',
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: ['acct_app'] },
            },
        };
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toEqual(expect.objectContaining({
            kind: 'warning',
            title: 'server.relayDrift.bannerDifferentRelayTitle',
        }));
    });

    it('re-reads the local facts after a repair succeeds instead of projecting the pre-repair state', async () => {
        // The ambient inspection is one promise per app open. The repair the banner just ran
        // changed the very facts it classifies, so continuing to project them would leave a
        // permanent "different relay" banner over a daemon that is now on the right relay.
        state.isTauriDesktop = true;
        // The repair takes this computer off the daemon's relay, so it asks first (N1): "Move it".
        modalAnswers.moveAnswer = 'setupSurface.relayMoveConfirm';
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const DRIFTED_STATUS_DATA = localFactsForDaemon({
            serverUrl: 'https://daemon-relay.example.test',
            serviceInstalled: true,
            controlReachable: true,
        });
        const CONVERGED_STATUS_DATA = localFactsForDaemon({
            serverUrl: 'https://relay.example.test',
            serviceInstalled: true,
            controlReachable: true,
        });
        let statusReads = 0;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: async (spec: unknown) => {
                    const kind = (spec as { kind: string }).kind;
                    if (kind !== 'daemon.service.status.v1') return 'task_setup';
                    statusReads += 1;
                    return `task_status_${statusReads}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    if (taskId.startsWith('task_status_')) {
                        const data = taskId === 'task_status_1' ? DRIFTED_STATUS_DATA : CONVERGED_STATUS_DATA;
                        queueMicrotask(() => listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data }));
                    }
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });
        state.cachedDoctorSnapshot = null;
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(banner).not.toBeNull();

        await renderer.act(async () => {
            await banner?.onPress();
        });
        await renderer.act(async () => {
            listeners.get('task_setup')?.onResult({
                protocolVersion: 1,
                taskId: 'task_setup',
                ok: true,
                data: { machineId: 'machine-1' },
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toBeNull();
    });

    it('exposes a secondary action for switching to the daemon relay when the daemon is connected to a different relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://daemon-relay.example.test',
                    publicServerUrl: 'https://daemon-relay.example.test',
                    webappUrl: 'https://daemon-relay.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        const secondaryActionLabel = (resolvedBanner as unknown as { secondaryActionLabel?: unknown }).secondaryActionLabel;
        expect(secondaryActionLabel).toBe('server.switchToServer');

        await renderer.act(async () => {
            await (resolvedBanner as unknown as { onSecondaryPress?: () => void | Promise<void> }).onSecondaryPress?.();
        });

        expect(upsertAndActivateServerSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://daemon-relay.example.test',
        }));
        expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).toHaveBeenCalled();
    });

    it('warns when the local daemon is healthy on this relay but paired to another account (F7)', async () => {
        // Nothing is wrong with the relay, the service or the credentials — they just belong to
        // someone else's account. The gate refuses to repoint it silently, so with the banner
        // silent too the only thing that re-offered setup was a relaunch.
        state.isTauriDesktop = true;
        const facts = localFactsForDaemon({
            serverUrl: 'https://relay.example.test',
            serviceInstalled: true,
            controlReachable: true,
        });
        await installAmbientLocalFacts({
            ...facts,
            auth: { ...facts.auth, accountId: 'acct_other', validatedAccountId: 'acct_other' },
        });
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(banner).toEqual(expect.objectContaining({
            kind: 'warning',
            title: 'server.relayDrift.bannerAccountMismatchTitle',
            description: expect.stringContaining('server.relayDrift.bannerAccountMismatchDescription'),
            actionLabel: 'server.relayDrift.connectHereAction',
        }));
    });

    async function renderDesktopBanner(data: unknown): Promise<() => RelayDriftBanner | null> {
        state.isTauriDesktop = true;
        await installAmbientLocalFacts(data);
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        return () => banner;
    }

    it('says in one sentence which relay and account this computer is connected to, with one action (R17/U7)', async () => {
        const facts = localFactsForDaemon({ serverUrl: 'https://daemon-relay.example.test', serviceInstalled: true, controlReachable: true });
        const read = await renderDesktopBanner({ ...facts, auth: { ...facts.auth, accountLabel: 'bob' } });

        const banner = read();
        expect(banner?.description).toContain('daemon-relay.example.test');
        expect(banner?.description).not.toContain('https://');
        expect(banner?.description).toContain('bob');
        expect(banner?.actionLabel).toBe('server.relayDrift.connectHereAction');
    });

    it('names both accounts when this computer is signed in as someone else on this relay (R17/D1)', async () => {
        const facts = localFactsForDaemon({ serverUrl: 'https://relay.example.test', serviceInstalled: true, controlReachable: true });
        const read = await renderDesktopBanner({
            ...facts,
            auth: { ...facts.auth, accountId: 'acct_other', validatedAccountId: 'acct_other', accountLabel: 'bob' },
        });

        const banner = read();
        expect(banner?.title).toBe('server.relayDrift.bannerAccountMismatchTitle');
        expect(banner?.description).toContain('relay.example.test');
        expect(banner?.description).toContain('bob');
        expect(banner?.description).toContain('acct_app');
        expect(banner?.actionLabel).toBe('server.relayDrift.connectHereAction');
    });

    it('stays quiet when the credential check could not reach the relay, instead of claiming sign-in (U9)', async () => {
        const facts = localFactsForDaemon({ serverUrl: 'https://relay.example.test', serviceInstalled: true, controlReachable: true });
        const read = await renderDesktopBanner({
            ...facts,
            needsAuth: false,
            auth: { ...facts.auth, credentialState: 'unknown', validatedAccountId: null },
        });

        expect(read()).toBeNull();
    });

    it('offers the one connect action when the relay matches but the daemon still needs auth', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://relay.example.test',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        expect(resolvedBanner?.actionLabel).toBe('server.relayDrift.connectHereAction');
    });
});
