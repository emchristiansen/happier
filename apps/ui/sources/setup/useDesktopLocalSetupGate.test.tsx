import {
    createSetupCliChoicePromptData,
    createSetupPairingPromptData,
    createSetupServiceConsentPromptData,
    SYSTEM_TASK_PROTOCOL_VERSION,
    type SetupCliChoicePromptPayload,
    type SystemTaskSpec,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskBridgeListenerSet, SystemTaskRunner } from '@/components/systemTasks/types';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { storage as appStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/persistence';

import type { DesktopLocalInspection, DesktopLocalReadinessFacts } from './deriveDesktopLocalSetupSnapshot';
import { createDesktopSetupCoordinator, desktopSetupCoordinator } from './desktopSetupCoordinator';
import * as directRelaySelectionIntent from './directRelaySelectionIntent';
import { DesktopLocalSetupPanel } from './DesktopLocalSetupPanel';
import { DesktopLocalSetupRuntime } from './DesktopLocalSetupRuntime';
import { useDesktopLocalSetupGate, type DesktopLocalSetupGate } from './useDesktopLocalSetupGate';
import { rememberKeptBackgroundService } from './desktopRelayMovePreference';

/**
 * A11-11 — the gate runs against its REAL owners: the coordinator (one inspection, one readiness
 * proof, the move question), the setup task hook, the direct-selection intent, the background
 * service commands and the consent presenters (each case a fresh real coordinator instance). Only
 * genuine boundaries are faked: the desktop system-task bridge (what the executor answers), the
 * machine RPC, the modal stack, secure token storage, native MMKV persistence, and the
 * app's active-server / account / auth state.
 */
const state = vi.hoisted(() => ({
    activeServer: {
        serverId: 'custom-2',
        serverUrl: 'https://relay.example.test',
        activeLocalRelayUrl: null as string | null,
        generation: 1,
    },
    accountId: 'acct_app' as string | null,
    authenticatedThisRun: false,
}));

/** What the executor answers each `daemon.service.status.v1` read: an inspection, or `hold` (never answers). */
type StatusAnswer = DesktopLocalInspection | 'hold';

/** The desktop system-task bridge: the one boundary between the app and the executor. */
const bridge = vi.hoisted(() => ({
    runner: null as SystemTaskRunner | null,
    counter: 0,
    starts: [] as { taskId: string; spec: SystemTaskSpec }[],
    listeners: new Map<string, SystemTaskBridgeListenerSet>(),
    responses: [] as { taskId: string; answer: unknown }[],
    /** Answers for the next status reads, in order; then `statusAnswer` for every later one. */
    statusOnce: [] as unknown[],
    statusAnswer: { status: 'pending' } as unknown,
    /** How `daemon.service.start.v1` settles (H6's quiet start). */
    serviceStart: 'ok' as 'ok' | 'hold' | 'fail',
}));

/** The modal stack: the consent presenters are real and speak through it. */
const modal = vi.hoisted(() => ({
    calls: [] as { kind: 'alert' | 'confirm'; title: string; body: string }[],
    /** The button texts an alert presses, first match wins; empty presses nothing (dismissed). */
    alertPress: [] as string[],
    /** `Modal.confirm` answers by title key. */
    confirm: {} as Record<string, boolean>,
}));

const spies = vi.hoisted(() => ({
    /** The one read-only proof that this daemon answers now (INV10). */
    machineRpc: vi.fn(async (_params: unknown) => ({ ok: true }) as unknown),
    /** Secure credential storage, read only once a pairing passed every binding check. */
    getCredentialsForServerUrl: vi.fn(async (_relayUrl: string, _options?: unknown) => null as unknown),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => spies.machineRpc(params),
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => bridge.runner,
}));

/**
 * The coordinator is a module singleton holding one inspection per app open. Each case gets a
 * fresh REAL instance from the module's own factory (every method is the production code) instead
 * of re-evaluating the whole module graph with `vi.resetModules()` per case.
 */
const coordinatorRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('./desktopSetupCoordinator', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./desktopSetupCoordinator')>();
    const current = () => coordinatorRef.current as import('./desktopSetupCoordinator').DesktopSetupCoordinator;
    const delegate: import('./desktopSetupCoordinator').DesktopSetupCoordinator = {
        inspect: (options) => current().inspect(options),
        subscribe: (listener) => current().subscribe(listener),
        readInspectionSnapshot: () => current().readInspectionSnapshot(),
        readInspectionRefreshing: () => current().readInspectionRefreshing(),
        readInspectionTaskId: () => current().readInspectionTaskId(),
        refreshOnTrayPointer: () => current().refreshOnTrayPointer(),
        readObservedExpectation: () => current().readObservedExpectation(),
        verifyCurrentTarget: (options) => current().verifyCurrentTarget(options),
        startSetup: (params) => current().startSetup(params),
        reconcile: (params) => current().reconcile(params),
        readLaunchedRunMovesRelay: (taskId) => current().readLaunchedRunMovesRelay(taskId),
        isSetupActive: () => current().isSetupActive(),
        readSetupRun: () => current().readSetupRun(),
        readSetupOperation: () => current().readSetupOperation(),
        readSetupStarting: () => current().readSetupStarting(),
        readSetupStartError: () => current().readSetupStartError(),
        launchSetupTask: (params) => current().launchSetupTask(params),
    };
    return { ...actual, desktopSetupCoordinator: delegate };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: async (title, body, buttons) => {
                modal.calls.push({ kind: 'alert', title: String(title), body: String(body ?? '') });
                const button = (buttons ?? []).find((entry) => modal.alertPress.includes(String(entry.text)));
                button?.onPress?.();
            },
            confirm: async (title, body) => {
                modal.calls.push({ kind: 'confirm', title: String(title), body: String(body ?? '') });
                return modal.confirm[String(title)] ?? true;
            },
        },
    }).module;
});

// Secure storage is a platform boundary; everything else in the pairing approval stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: (relayUrl: string, options?: unknown) => spies.getCredentialsForServerUrl(relayUrl, options),
        },
    };
});

// D5 uses the real device-local store, writers and useLocalSetting subscription. Vitest's
// canonical native MMKV boundary supplies in-memory persistence; no store projection is mocked.

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ authenticatedThisRun: state.authenticatedThisRun }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => state.activeServer,
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (state.accountId ? { serverId: state.activeServer.serverId, accountId: state.accountId } : null),
}));

/** D5 — "Keep it as is", remembered on this device: in the real local-settings store and the gate's read. */
function setKeptBackgroundService(identity: { relayKey: string; accountId: string | null } | null): void {
    appStorage.getState().applyLocalSettings({
        desktopKeptBackgroundService: identity,
        desktopAlwaysMoveDefaultFollowingService: false,
    });
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A daemon configured for `https://old.example.test` — a relay the app is not on — so the pure
 * entry policy derives `setup` and the gate must decide whether the executor may run at all.
 */
const DRIFTED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: null, channel: null },
        server: {
            serverUrl: 'https://old.example.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
        auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', accountLabel: null, machineId: 'machine-1' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    },
};

/** The same daemon, after the executor pointed it at the relay the app is on. */
const READY_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        ...DRIFTED_INSPECTION.facts,
        server: {
            serverUrl: 'https://relay.example.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
    },
};

/**
 * A computer with nothing set up yet: no service, no credentials, no machine. This is the ordinary
 * first-install case, and the only one the gate may converge silently — there is no service of the
 * user's to move.
 */
const UNCONFIGURED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        ...READY_INSPECTION.facts,
        auth: { credentialState: 'missing', validatedAccountId: null, accountId: null, accountLabel: null, machineId: null },
        service: { installed: false, running: false, autostart: null, targetMode: null },
        runtimeConvergence: {
            controlReachable: false,
            serviceOwnsRunningDaemon: false,
            machineIdMatches: false,
            cliVersionMatches: false,
        },
    },
};

/** The app's own on-demand service on the app's relay and account, stopped after the last quit. */
const ON_DEMAND_STOPPED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        ...READY_INSPECTION.facts,
        service: { installed: true, running: false, autostart: 'on-demand', targetMode: 'default-following' },
        runtimeConvergence: {
            controlReachable: false,
            serviceOwnsRunningDaemon: false,
            machineIdMatches: false,
            cliVersionMatches: false,
        },
    },
};

/** A relay's own desktop-managed on-demand service beside the ready app relay, stopped. */
function readyWithStoppedPinnedService(): DesktopLocalInspection {
    const ready = READY_INSPECTION as Extract<DesktopLocalInspection, { status: 'resolved' }>;
    return {
        ...ready,
        pinnedServices: [{
            ...ready.facts,
            server: { ...ready.facts.server, serverUrl: 'https://relay-b.example.test' },
            service: { ...ready.facts.service, running: false, autostart: 'on-demand', targetMode: 'pinned', managedBy: 'desktop' },
            runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
        }],
        pinnedServicesComplete: true,
    };
}

/** One daemon's facts the way `daemon.service.status.v1` sends them (the coordinator parses them). */
function toStatusFacts(facts: DesktopLocalReadinessFacts): Record<string, unknown> {
    return {
        acquisition: { ...facts.acquisition },
        server: { ...facts.server },
        auth: { ...facts.auth },
        service: {
            installed: facts.service.installed,
            running: facts.service.running,
            autostart: facts.service.autostart,
            targetMode: facts.service.targetMode,
        },
        runtimeConvergence: facts.runtimeConvergence ? { ...facts.runtimeConvergence } : null,
        cli: { update: null, choice: { mode: facts.cliChoice.mode, otherCli: null } },
        ...(facts.service.managedBy === 'desktop' ? { managedBy: 'desktop' } : {}),
    };
}

/** The executor's row for one service (bootstrap `listThisComputerServiceRows`). */
function toServiceRow(facts: DesktopLocalReadinessFacts, mode: 'default-following' | 'pinned') {
    const reachable = facts.runtimeConvergence?.controlReachable === true;
    return {
        relayUrl: facts.server.serverUrl,
        state: reachable ? 'connected' : 'offline',
        appManaged: mode === 'default-following' || facts.service.managedBy === 'desktop',
        serving: mode,
        actions: reachable ? ['restart', 'stop'] : ['start'],
    };
}

function toStatusResult(taskId: string, inspection: DesktopLocalInspection): unknown {
    if (inspection.status === 'failed') {
        return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: inspection.error };
    }
    if (inspection.status !== 'resolved') {
        throw new Error('a pending inspection is a status read that never answers: use `hold`');
    }
    const pinned = inspection.pinnedServices ?? [];
    const defaultListed = inspection.facts.service.installed || inspection.facts.runtimeConvergence?.controlReachable === true;
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId,
        ok: true,
        data: {
            ...toStatusFacts(inspection.facts),
            pinnedServices: { complete: true, coexistence: true, services: pinned.map(toStatusFacts), unreadable: [] },
            serviceRows: [
                ...(defaultListed && inspection.facts.server.serverUrl ? [toServiceRow(inspection.facts, 'default-following')] : []),
                ...pinned.filter((facts) => facts.service.installed).map((facts) => toServiceRow(facts, 'pinned')),
            ],
        },
    };
}

/** The status read's answer, like `inspect.mockImplementation` (every later read). */
function answerStatus(answer: StatusAnswer): void {
    bridge.statusAnswer = answer;
}

/** The next status read's answer only, like `inspect.mockImplementationOnce`. */
function answerNextStatus(answer: StatusAnswer): void {
    bridge.statusOnce.push(answer);
}

function startsOf(kind: string): { taskId: string; spec: SystemTaskSpec }[] {
    return bridge.starts.filter((start) => start.spec.kind === kind);
}

function latestSetupTaskId(): string {
    const run = startsOf('setup.thisComputer.v1').at(-1);
    if (!run) throw new Error('no setup run was launched');
    return run.taskId;
}

function installBridge(): void {
    bridge.runner = createSystemTaskRunner({
        mode: 'dev',
        bridge: {
            start: async (spec) => {
                const taskId = `${spec.kind}#${++bridge.counter}`;
                bridge.starts.push({ taskId, spec });
                return taskId;
            },
            subscribe: async (taskId, listeners) => {
                bridge.listeners.set(taskId, listeners);
                const kind = taskId.slice(0, taskId.indexOf('#'));
                if (kind === 'daemon.service.status.v1') {
                    const answer = (bridge.statusOnce.length > 0 ? bridge.statusOnce.shift() : bridge.statusAnswer) as StatusAnswer;
                    if (answer !== 'hold') {
                        const result = toStatusResult(taskId, answer);
                        queueMicrotask(() => listeners.onResult(result));
                    }
                } else if (kind === 'daemon.service.start.v1' && bridge.serviceStart !== 'hold') {
                    const result = bridge.serviceStart === 'ok'
                        ? { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: {} }
                        : { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: { code: 'start_failed', message: 'start failed' } };
                    queueMicrotask(() => listeners.onResult(result));
                }
                return () => {
                    bridge.listeners.delete(taskId);
                };
            },
            cancel: async () => {},
            respond: async (taskId, answer) => {
                bridge.responses.push({ taskId, answer });
            },
        },
    });
}

let promptClock = 1;

/** The executor raises a prompt on the gate's setup run. */
async function emitSetupPrompt(data: unknown): Promise<void> {
    const taskId = latestSetupTaskId();
    await renderer.act(async () => {
        bridge.listeners.get(taskId)?.onEvent({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, tsMs: promptClock++, type: 'prompt', data });
    });
    await settle();
}

/** The executor finishes the gate's setup run successfully. */
async function finishSetupRun(): Promise<void> {
    const taskId = latestSetupTaskId();
    await renderer.act(async () => {
        bridge.listeners.get(taskId)?.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: { machineId: 'machine-1' } });
    });
    await settle();
}

/** Lets the real async chain (bridge → runner → coordinator → gate) settle. */
async function settle(rounds = 8): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}


/** Observes the real coordinator's two launch paths without replacing them. */
function spyOnLaunchPaths() {
    const coordinator = desktopSetupCoordinator;
    return {
        startSetup: vi.spyOn(coordinator, 'startSetup'),
        reconcile: vi.spyOn(coordinator, 'reconcile'),
        verifyCurrentTarget: vi.spyOn(coordinator, 'verifyCurrentTarget'),
    };
}

/**
 * The app opened on `custom-2` and read this computer there (the warm-up read the gate later
 * shares), then something moved it to `serverId`: what the app expected when the facts were read
 * is where it opened, not where it is now.
 */
async function openedOnRelayThenMovedTo(serverId: string, serverUrl: string): Promise<void> {
    await desktopSetupCoordinator.inspect();
    state.activeServer = { serverId, serverUrl, activeLocalRelayUrl: null, generation: state.activeServer.generation + 1 };
}

let observedGate: DesktopLocalSetupGate | null = null;
let authenticate: (() => void) | null = null;
/** Re-reads the mocked active server, the way the real store subscription would. */
let refreshIdentity: (() => void) | null = null;

async function renderGate(enabled = true) {
    function Harness(props: Readonly<{ initialEnabled: boolean }>) {
        const [gateEnabled, setGateEnabled] = React.useState(props.initialEnabled);
        const [, setTick] = React.useState(0);
        authenticate = () => setGateEnabled(true);
        refreshIdentity = () => setTick((value) => value + 1);
        observedGate = useDesktopLocalSetupGate({ enabled: gateEnabled });
        return React.createElement('GateProbe', {
            presentation: observedGate.snapshot.presentation,
            state: observedGate.snapshot.state,
        });
    }
    const screen = await renderScreen(React.createElement(Harness, { initialEnabled: enabled }));
    await settle();
    return screen;
}

/** The pairing prompt the executor raises for the app's relay and account. */
function pairingPrompt(cliProvenance: 'managed' | 'override', cliCommand: string) {
    return createSetupPairingPromptData({
        publicKeyB64Url: 'cHVibGljLWtleQ',
        relayUrl: 'https://relay.example.test',
        serverIdentityKey: 'https://relay.example.test',
        accountId: 'acct_app',
        pairingRequirement: 'compatible',
        cliProvenance,
        cliCommand,
    });
}

async function resetHarness(): Promise<void> {
    vi.restoreAllMocks();
    bridge.counter = 0;
    bridge.starts = [];
    bridge.listeners.clear();
    bridge.responses = [];
    bridge.statusOnce = [];
    bridge.statusAnswer = UNCONFIGURED_INSPECTION;
    bridge.serviceStart = 'ok';
    modal.calls = [];
    // The move question's default answer is "Move" (either kind of move).
    modal.alertPress = ['setupSurface.relayMoveConfirm', 'setupSurface.accountMoveConfirm'];
    modal.confirm = { 'setupSurface.consentTitle': true, 'setupSurface.consentTakeoverTitle': true, 'setupSurface.cliTrustTitle': false };
    spies.machineRpc.mockReset();
    spies.machineRpc.mockImplementation(async () => ({ ok: true }));
    spies.getCredentialsForServerUrl.mockReset();
    spies.getCredentialsForServerUrl.mockImplementation(async () => null);
    state.activeServer = { serverId: 'custom-2', serverUrl: 'https://relay.example.test', activeLocalRelayUrl: null, generation: 1 };
    state.accountId = 'acct_app';
    state.authenticatedThisRun = false;
    setKeptBackgroundService(null);
    observedGate = null;
    authenticate = null;
    refreshIdentity = null;
    installBridge();
    // A fresh app open: one new real coordinator, and no direct relay choice made yet.
    coordinatorRef.current = createDesktopSetupCoordinator({ runner: () => bridge.runner! });
    directRelaySelectionIntent.recordDirectRelaySelectionIntent('');
}

describe('useDesktopLocalSetupGate — what may mutate the local daemon (R8/INV7)', () => {
    beforeEach(async () => {
        await resetHarness();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('adopts an explicit leaf run at the shell and proves success after the leaf leaves', async () => {
        answerStatus(READY_INSPECTION);
        await renderGate();
        const previousProofs = spies.machineRpc.mock.calls.length;
        const leaf = await renderHook(() => useThisComputerSetupTask({ runner: bridge.runner! }));
        await renderer.act(async () => {
            await leaf.getCurrent().launch(buildLocalMachineSetupSystemTaskSpec({
                activeRelayUrl: state.activeServer.serverUrl,
                activeWebappUrl: state.activeServer.serverUrl,
                activeLocalRelayUrl: null,
                expectedAccountId: 'acct_app',
                channel: 'stable',
            }));
        });
        const taskId = leaf.getCurrent().activeTaskId;
        await leaf.unmount();
        expect(observedGate?.setupTask.activeTaskId).toBe(taskId);
        await completeSetup();
        await settle();
        expect(spies.machineRpc.mock.calls.length).toBe(previousProofs + 1);
        expect(observedGate?.verification.status).toBe('verified');
    });

    it('retries a failed explicit CLI choice even when the existing runtime is already ready', async () => {
        answerStatus(READY_INSPECTION);
        await renderGate();
        const leaf = await renderHook(() => useThisComputerSetupTask({ runner: bridge.runner! }));
        await renderer.act(async () => {
            await leaf.getCurrent().launch(buildLocalMachineSetupSystemTaskSpec({
                activeRelayUrl: state.activeServer.serverUrl,
                activeWebappUrl: state.activeServer.serverUrl,
                activeLocalRelayUrl: null,
                expectedAccountId: 'acct_app',
                channel: 'stable',
                reconsiderCli: true,
            }));
        });
        await leaf.unmount();
        const taskId = latestSetupTaskId();
        await renderer.act(async () => {
            bridge.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false,
                error: { code: 'cli_install_failed', message: 'CLI choice could not finish' },
            });
        });
        await settle();
        await renderer.act(async () => observedGate?.retry());
        await settle();
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(2);
        expect(startsOf('setup.thisComputer.v1')[1]?.spec.params).toMatchObject({ reconsiderCli: true });
    });

    it('does not dismiss a new account when an original retained setup prompt is declined', async () => {
        await renderGate();
        const taskId = latestSetupTaskId();
        state.accountId = 'acct_new';
        await renderer.act(async () => refreshIdentity?.());
        await settle();
        modal.confirm['setupSurface.consentTitle'] = false;
        await emitSetupPrompt(createSetupServiceConsentPromptData({
            takeover: null, message: null, competingServices: [], servicesToRemove: [],
        }));
        expect(bridge.responses).toEqual([{ taskId, answer: { approved: false } }]);
        expect(observedGate?.setupRunDismissed).toBe(false);
    });

    it('adopts a later explicit request after Continue without this computer dismissed an earlier run', async () => {
        await renderGate();
        await renderer.act(async () => observedGate?.continueWithoutThisComputer());
        expect(observedGate?.setupRunDismissed).toBe(true);
        const previousTaskId = latestSetupTaskId();
        await renderer.act(async () => {
            bridge.listeners.get(previousTaskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: previousTaskId, ok: false,
                error: { code: 'setup_failed', message: 'Previous setup stopped' },
            });
        });
        await settle();
        const leaf = await renderHook(() => useThisComputerSetupTask({ runner: bridge.runner! }));
        await renderer.act(async () => { await leaf.getCurrent().start(); });
        expect(observedGate?.setupTask.activeTaskId).not.toBe(previousTaskId);
        expect(observedGate?.setupRunDismissed).toBe(false);
    });

    it('keeps Continue without this computer bound through a pending pre-launch inspection', async () => {
        answerNextStatus({ status: 'failed', error: { code: 'cli_choice_required', message: 'CLI choice required' } });
        answerStatus('hold');
        await renderGate();
        expect(observedGate?.setupTask.isStarting).toBe(true);
        expect(observedGate?.setupTask.activeTaskId).toBeNull();
        await renderer.act(async () => observedGate?.continueWithoutThisComputer());
        const statusTaskId = startsOf('daemon.service.status.v1').at(-1)?.taskId;
        expect(statusTaskId).toBeDefined();
        await renderer.act(async () => {
            if (statusTaskId) bridge.listeners.get(statusTaskId)?.onResult(toStatusResult(statusTaskId, UNCONFIGURED_INSPECTION));
        });
        await settle();
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(1);
        expect(observedGate?.setupRunDismissed).toBe(true);
    });

    it('does not quietly start a stopped service while a retained setup operation owns this computer', async () => {
        await renderGate();
        answerStatus(ON_DEMAND_STOPPED_INSPECTION);
        await renderer.act(async () => {
            await desktopSetupCoordinator.inspect({ fresh: true });
        });
        await settle();
        expect(startsOf('daemon.service.start.v1')).toEqual([]);
    });

    it('converges a computer with nothing installed through the plain executor', async () => {
        // Nothing of the user's is being moved, so there is no UD5 question to ask.
        const launches = spyOnLaunchPaths();
        await renderGate();

        expect(launches.startSetup).toHaveBeenCalledTimes(1);
        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(1);
        expect(modal.calls).toEqual([]);
    });

    it('starts setup — whose first step is the one-CLI question — when the read failed on a CLI nobody chose yet (R12)', async () => {
        // A Retry that only re-reads can never get past this; the executor asks the question.
        answerStatus({
            status: 'failed',
            error: { code: 'cli_choice_required', message: 'The Happier CLI at /usr/local/bin/happier could not answer' },
        });
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.startSetup).toHaveBeenCalledTimes(1);
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(1);
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'panel', reason: 'cli_choice_required' });
    });

    it('routes a relaunch whose daemon is still on another relay through reconciliation, never a silent repoint (B2)', async () => {
        // The ambient device-scope switch that moved the app here was PERSISTED, so this open has
        // nothing to compare: the app expected this relay when it read the facts, and the daemon
        // is still on the old one. Deciding from the expectation alone therefore called the plain
        // executor and repointed a background service the user never asked to move — INV7's
        // forbidden mutation, deferred by one relaunch. The facts answer it the same way in any
        // run: this service is installed, this installation owns it, and it is somewhere else.
        answerStatus(DRIFTED_INSPECTION);
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
        // The move was asked before anything ran.
        expect(modal.calls.map((call) => call.title)).toEqual(['setupSurface.relayMoveTitle']);
    });

    it('reconciles a relaunch whose daemon is validated for another account (B2)', async () => {
        const ready = READY_INSPECTION as Extract<DesktopLocalInspection, { status: 'resolved' }>;
        answerStatus({
            status: 'resolved',
            facts: { ...ready.facts, auth: { ...ready.facts.auth, validatedAccountId: 'acct_other', accountId: 'acct_other' } },
        });
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('reconciles a direct Relay/Home selection through the coordinator', async () => {
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        directRelaySelectionIntent.recordDirectRelaySelectionIntent('custom-3');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('performs no daemon mutation for a group selection', async () => {
        // A group may contain several relays and cannot name one daemon target (B2), so the group
        // action records no direct-selection intent.
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(launches.startSetup).not.toHaveBeenCalled();
        expect(startsOf('setup.thisComputer.v1')).toEqual([]);
    });

    it('performs no daemon mutation for a notification-driven server change', async () => {
        // Notification routing, session navigation, voice and machine detail all switch with
        // scope `device`; none of them is the direct Relay/Home action, so no intent exists.
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(launches.startSetup).not.toHaveBeenCalled();
        expect(startsOf('setup.thisComputer.v1')).toEqual([]);
    });

    it('shows no setup panel for an ambient relay switch, instead of a panel over nothing (B1)', async () => {
        // A notification moved the app to a relay this computer's daemon is not on. Nothing may be
        // repointed for it (INV7), so nothing runs — and a setup panel with no run, no progress
        // and no action is not an honest way to say so. It is the same answer as declining the
        // move: not ready, not claiming to be, and the drift banner carries it.
        answerStatus(DRIFTED_INSPECTION);
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(launches.startSetup).not.toHaveBeenCalled();
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'hidden' });
    });

    it('acts on a direct Relay/Home pick of the relay the app is already on (B1)', async () => {
        // The case an identity comparison cannot see: the ambient switch above already moved the
        // app here and the gate refused to move the daemon. The user now picks this relay on
        // purpose. Nothing about the app changes, so only the choice itself can say the question
        // was answered — otherwise the deliberate pick does nothing at all.
        answerStatus(DRIFTED_INSPECTION);
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const launches = spyOnLaunchPaths();

        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('hidden');
        expect(launches.reconcile).not.toHaveBeenCalled();

        const intent = directRelaySelectionIntent;
        await renderer.act(async () => {
            intent.recordDirectRelaySelectionIntent('custom-3');
        });
        await settle();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        // The refusal was about the ambient switch, not about this relay forever: the answer the
        // user just gave releases it, so the surface is not stuck in a declined state.
        expect(observedGate?.snapshot.presentation).not.toBe('hidden');
    });

    it('performs no daemon mutation for an ambient server change that lands back on the durable preference', async () => {
        // The counterexample the durable preference cannot answer: `custom-3` IS the user's
        // default relay, so after a notification moved the app to `custom-2` and navigation
        // brought it back, the persisted target and the active server agree again — and they
        // agree for a reason the user never asked for. Only the direct action can say otherwise,
        // and it said nothing this run.
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('asks the direct action, and spends its intent instead of re-reading persisted state', async () => {
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        const intent = directRelaySelectionIntent;
        intent.recordDirectRelaySelectionIntent('custom-3');
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        // Spent, not peeked at: nothing may move the daemon a second time on the strength of one
        // choice the user made once.
        expect(intent.consumeDirectRelaySelectionIntent('custom-3')).toBe(false);

        // An ambient change now takes the app away and straight back to the same relay.
        state.activeServer = { serverId: 'custom-4', serverUrl: 'https://other.example.test', activeLocalRelayUrl: null, generation: 3 };
        await renderer.act(async () => {
            refreshIdentity?.();
        });
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 4 };
        await renderer.act(async () => {
            refreshIdentity?.();
        });
        await settle();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('routes a same-relay account change through the reconciliation decision', async () => {
        // The relay did not change, but the account did, so the executor is about to re-pair this
        // computer's service to a different account. That is the UD5 question, not ordinary entry
        // convergence, and deciding it by server id alone skipped the consent entirely.
        state.accountId = 'acct_previous';
        await desktopSetupCoordinator.inspect();
        state.accountId = 'acct_app';
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('reconciles a signed-out direct selection only once authentication has completed', async () => {
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        directRelaySelectionIntent.recordDirectRelaySelectionIntent('custom-3');
        const launches = spyOnLaunchPaths();

        await renderGate(false);
        expect(launches.reconcile).not.toHaveBeenCalled();

        // The explicit authentication completes and the desktop root enables the gate.
        state.authenticatedThisRun = true;
        await renderer.act(async () => {
            authenticate?.();
        });
        await settle();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
    });

    /** Completes the executor run the gate started; the gate then re-reads facts and proves them. */
    async function completeSetup(): Promise<void> {
        answerStatus(READY_INSPECTION);
        await finishSetupRun();
    }

    it('reveals only once the machine answers a read-only RPC, and proves it through the existing owner (INV10)', async () => {
        const launches = spyOnLaunchPaths();
        await renderGate();
        expect(launches.startSetup).toHaveBeenCalledTimes(1);

        await completeSetup();

        expect(spies.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'custom-2',
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
        });
        expect(observedGate?.verification.status).toBe('verified');
        expect(observedGate?.snapshot.state).toBe('ready');
    });

    it('fails closed on the Home panel when the machine does not answer (INV10)', async () => {
        state.authenticatedThisRun = true;
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms while using active scope for capabilities.describe');
        });

        await renderGate();
        await completeSetup();

        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        expect(observedGate?.snapshot.state).not.toBe('ready');
        expect(observedGate?.snapshot).toMatchObject({ presentation: 'panel', reason: 'machine_unreachable' });
    });

    it('is unaffected by a client clock far ahead of or far behind the relay (A0)', async () => {
        const realNow = Date.now;
        try {
            for (const skewMs of [36 * 60 * 60 * 1000, -36 * 60 * 60 * 1000]) {
                // A fresh app open for each clock: the coordinator keeps one inspection per open.
                await resetHarness();
                answerStatus(DRIFTED_INSPECTION);
                Date.now = () => realNow() + skewMs;

                await renderGate();
                await completeSetup();

                expect(observedGate?.verification.status).toBe('verified');
                expect(observedGate?.snapshot.state).toBe('ready');
                standardCleanup();
            }
        } finally {
            Date.now = realNow;
        }
    });

    it('reconciles a direct Relay/Home selection made after a setup already verified (R8/SB4)', async () => {
        const launches = spyOnLaunchPaths();
        await renderGate();
        expect(launches.startSetup).toHaveBeenCalledTimes(1);

        await completeSetup();
        expect(observedGate?.verification.status).toBe('verified');

        // The user now picks a different Relay in the footer. Nothing re-inspects (D3); the
        // same facts now describe a relay the app has left, so the snapshot reads `setup`.
        // The previous attempt's proof belongs to that old relay and must not park the gate.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        directRelaySelectionIntent.recordDirectRelaySelectionIntent('custom-3');
        await renderer.act(async () => {
            refreshIdentity?.();
        });
        await settle();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
    });

    it('names a re-read that did not converge instead of working forever (INV8/F2)', async () => {
        // The executor reported success, but the fresh read still describes a daemon that is not
        // this relay's. Nothing may be asked of the machine and nothing may claim ready — and the
        // gate must SETTLE, because a surface left "working" has no Retry and setup cannot
        // restart from it.
        state.authenticatedThisRun = true;
        const launches = spyOnLaunchPaths();
        await renderGate();
        expect(launches.startSetup).toHaveBeenCalledTimes(1);

        await finishSetupRun();

        expect(launches.verifyCurrentTarget).toHaveBeenCalledWith({ fresh: true });
        expect(spies.machineRpc).not.toHaveBeenCalled();
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'runtime_not_converged' });
        expect(observedGate?.snapshot.state).not.toBe('ready');
    });

    it('presents later maintenance on the panel once the first run has settled (R11/F4)', async () => {
        state.authenticatedThisRun = true;
        await renderGate();
        await completeSetup();
        expect(observedGate?.snapshot).toMatchObject({ state: 'ready', presentation: 'hidden' });

        // Hours later, still the same app run: the user picks a different Relay themselves. This
        // is maintenance in an app they are using; the panel carries it, nothing blocks.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        directRelaySelectionIntent.recordDirectRelaySelectionIntent('custom-3');
        await renderer.act(async () => {
            refreshIdentity?.();
        });
        await settle();

        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'panel' });
    });

    it('takes the panel away when the user keeps the background service already on this computer (F5)', async () => {
        // "Keep it as is" is a decision, exactly like keeping the service where it is on a relay
        // move. Keeping a panel over it with a Retry that reopens the same question is a trap, so
        // the panel steps aside and setup stays available later.
        state.authenticatedThisRun = true;
        modal.confirm['setupSurface.consentTitle'] = false;

        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('panel');

        await emitSetupPrompt(createSetupServiceConsentPromptData({
            takeover: null,
            message: null,
            competingServices: [],
            servicesToRemove: [],
        }));

        expect(bridge.responses).toEqual([{ taskId: latestSetupTaskId(), answer: { approved: false } }]);
        expect(modal.calls.filter((call) => call.title === 'setupSurface.consentTitle')).toHaveLength(1);
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('quietly starts its own on-demand service on relaunch, with no panel and no executor (H6)', async () => {
        // The settings toggle promised this computer answers while the app is open. Keeping that
        // promise is a check, not maintenance: the service is already installed for this relay and
        // account, so the app runs the CLI's own start command and proves the result. Running the
        // whole executor under "Setting up this computer" on every single open was the old
        // behaviour, and it was maintenance UI standing in for a lifecycle.
        answerStatus(ON_DEMAND_STOPPED_INSPECTION);
        // Held in flight, so what the user sees WHILE the service starts is observable.
        bridge.serviceStart = 'hold';
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(startsOf('daemon.service.start.v1')).toHaveLength(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
        expect(launches.reconcile).not.toHaveBeenCalled();
        expect(observedGate?.snapshot).toMatchObject({ state: 'checking', presentation: 'hidden' });
    });

    it('quietly starts a relay\'s own on-demand service too while the app relay is ready (one login-start setting)', async () => {
        answerStatus(readyWithStoppedPinnedService());
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(startsOf('daemon.service.start.v1')).toHaveLength(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
        expect(launches.reconcile).not.toHaveBeenCalled();
    });

    it('starts no other relay\'s service while a setup run is active on this computer (F5)', async () => {
        answerStatus(readyWithStoppedPinnedService());
        // Another surface (Settings › This computer's repair) launched a setup run that is still
        // running: the executor owns this computer's services until it settles.
        const coordinator = desktopSetupCoordinator;
        await coordinator.startSetup({ start: (spec) => bridge.runner!.start(spec) });
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(1);

        await renderGate();

        expect(startsOf('daemon.service.start.v1')).toEqual([]);
    });

    it('reveals once the quietly started service proves itself (H6)', async () => {
        answerNextStatus(ON_DEMAND_STOPPED_INSPECTION);
        answerStatus(READY_INSPECTION);
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(startsOf('daemon.service.start.v1')).toHaveLength(1);
        expect(observedGate?.snapshot.state).toBe('ready');
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('settles instead of checking forever when the quiet start leaves the service stopped (H6)', async () => {
        answerStatus(ON_DEMAND_STOPPED_INSPECTION);

        await renderGate();

        expect(startsOf('daemon.service.start.v1')).toHaveLength(1);
        expect(observedGate?.snapshot.state).not.toBe('checking');
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'runtime_not_converged' });
    });

    it('converges again when a later read replaces the facts its proof was about (F1)', async () => {
        // A ready app, then any other reader re-reads: Machines › Refresh, the background-service
        // toggle after its install, a settings verify/adopt. The daemon has stopped since. The
        // verdict was about facts that no longer describe this computer, and holding onto it left
        // the trigger gated shut — a setup panel with no run, no progress and
        // no Retry, recoverable only by restarting the app.
        answerStatus(READY_INSPECTION);
        const launches = spyOnLaunchPaths();

        await renderGate();
        expect(observedGate?.snapshot.state).toBe('ready');
        expect(observedGate?.verification.status).toBe('verified');

        // Running, but no longer the version this app installed: a stopped service would get the
        // quiet start instead (D6), so the executor case needs a daemon that is up and wrong.
        const ready = READY_INSPECTION as Extract<DesktopLocalInspection, { status: 'resolved' }>;
        answerStatus({
            status: 'resolved',
            facts: {
                ...ready.facts,
                runtimeConvergence: {
                    controlReachable: true,
                    serviceOwnsRunningDaemon: false,
                    machineIdMatches: true,
                    cliVersionMatches: false,
                },
            },
        });
        const coordinator = desktopSetupCoordinator;
        await renderer.act(async () => {
            await coordinator.inspect({ fresh: true });
        });
        await settle();

        expect(observedGate?.verification.status).toBe('idle');
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', reason: 'daemon_not_converged' });
        expect(launches.startSetup).toHaveBeenCalledTimes(1);
        expect(launches.reconcile).not.toHaveBeenCalled();
    });

    it('keeps a settled verdict while the facts it was about stand (F1)', async () => {
        // The reset is keyed to the facts, not to time: a proof that failed must keep its named
        // state and its Retry until something actually re-reads this computer.
        answerStatus(READY_INSPECTION);
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms');
        });
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        await settle();
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('reads as checking while a re-read is in flight, without taking the facts from anyone else', async () => {
        // Retry has to be acknowledged on the next frame (`DESIGN.md`), and the gate is the reader
        // for which being mid-check is the thing worth showing. Every other reader — the drift
        // banner, the tray — keeps the facts it already had, which is why the coordinator no longer
        // publishes `pending` over them. Retry re-reads a read that failed (the coordinator redoes
        // only those).
        state.authenticatedThisRun = true;
        answerStatus({ status: 'failed', error: { code: 'bridge_unavailable', message: 'no bridge' } });
        await renderGate();
        expect(observedGate?.snapshot).toMatchObject({ state: 'blocked', reason: 'inspection_failed' });

        // A read that does not answer, so the in-flight window is observable.
        answerStatus('hold');
        await renderer.act(async () => {
            observedGate?.retry();
        });
        await settle();

        expect(observedGate?.snapshot.state).toBe('checking');
        expect(observedGate?.inspection.status).toBe('pending');
        expect(desktopSetupCoordinator.readInspectionSnapshot()).toMatchObject({ status: 'failed' });
    });

    it('asks before claiming a computer whose CLI a person signed in from a terminal as another account (U3)', async () => {
        // No app-owned service at all: the CLI was set up from a terminal as account B. Treating
        // it as a first install replaced B's credentials with no question.
        const unconfigured = UNCONFIGURED_INSPECTION as Extract<DesktopLocalInspection, { status: 'resolved' }>;
        answerStatus({
            status: 'resolved',
            facts: {
                ...unconfigured.facts,
                auth: { credentialState: 'valid', validatedAccountId: 'acct_terminal', accountId: 'acct_terminal', accountLabel: 'bob', machineId: 'machine-b' },
            },
        });
        const launches = spyOnLaunchPaths();

        await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(launches.startSetup).not.toHaveBeenCalled();
    });

    it('subscribes to the remembered Keep preference and reads it again on reopen (D5)', async () => {
        answerStatus(DRIFTED_INSPECTION);
        await desktopSetupCoordinator.inspect();
        const screen = await renderGate(false);
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'panel' });

        const kept = { relayKey: 'https://old.example.test', accountId: 'acct_app' };
        await renderer.act(async () => {
            rememberKeptBackgroundService(kept);
        });
        // No forced render or mirrored setting: the real local-setting subscription must notify.
        expect(loadLocalSettings().desktopKeptBackgroundService).toEqual(kept);
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'hidden' });

        await screen.unmount();
        // A fresh lifecycle reads persisted settings through the same real store.
        appStorage.setState({ localSettings: loadLocalSettings() });
        coordinatorRef.current = createDesktopSetupCoordinator({ runner: () => bridge.runner! });

        await renderGate();

        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'hidden' });
        expect(modal.calls).toEqual([]);
        expect(startsOf('setup.thisComputer.v1')).toEqual([]);
    });

    it('offers a way out of a blocked state that Retry cannot fix (U4)', async () => {
        // The machine was revoked from another device: convergence passes, the relay refuses it,
        // and Retry re-proves the same failure forever. The gate's own decline path takes the
        // panel away; nothing claims ready.
        answerStatus(READY_INSPECTION);
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('machine revoked');
        });
        state.authenticatedThisRun = true;

        await renderGate();
        expect(observedGate?.snapshot).toMatchObject({ state: 'blocked', presentation: 'panel', reason: 'machine_unreachable' });

        await renderer.act(async () => {
            observedGate?.continueWithoutThisComputer();
        });

        expect(observedGate?.snapshot).toMatchObject({ state: 'blocked', presentation: 'hidden' });
    });

    it('keeps the verify stage while a succeeded run is being proved, never dropping back to checking (U5)', async () => {
        state.authenticatedThisRun = true;
        const launches = spyOnLaunchPaths();
        await renderGate();
        expect(launches.startSetup).toHaveBeenCalledTimes(1);

        // The run succeeds; its proof re-reads, and that read is held in flight.
        answerStatus('hold');
        await finishSetupRun();

        expect(observedGate?.verification.status).toBe('verifying');
        expect(observedGate?.inspection.status).toBe('resolved');
        expect(observedGate?.snapshot.state).not.toBe('checking');
    });

    it('takes the panel away when the user keeps the service where it is', async () => {
        answerStatus(DRIFTED_INSPECTION);
        await openedOnRelayThenMovedTo('custom-3', 'https://new.example.test');
        directRelaySelectionIntent.recordDirectRelaySelectionIntent('custom-3');
        modal.alertPress = ['setupSurface.relayMoveKeep'];
        const launches = spyOnLaunchPaths();

        const screen = await renderGate();

        expect(launches.reconcile).toHaveBeenCalledTimes(1);
        expect(startsOf('setup.thisComputer.v1')).toEqual([]);
        expect(screen.findByType('GateProbe' as never).props.presentation).toBe('hidden');
        expect(screen.findByType('GateProbe' as never).props.state).toBe('setup');
    });
});

describe('useDesktopLocalSetupGate — override-CLI approval is attended, never a dead end (A1/A2)', () => {
    beforeEach(async () => {
        await resetHarness();
        state.authenticatedThisRun = true;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('wires the approval target from the identity it selected, even when the ambient inspection failed', async () => {
        // The inspection is an observation, not a precondition for answering the executor's own
        // pairing prompt. Gating the target on it left a failed inspection unable to approve
        // anything, so setup dead-ended on `approval_unavailable`.
        answerStatus({
            status: 'failed',
            error: { code: 'cli_choice_required', message: 'The Happier CLI at /usr/local/bin/happier could not answer' },
        });

        await renderGate();
        await emitSetupPrompt(pairingPrompt('managed', '/managed/happier'));

        // Every binding check passed against the relay, account and profile this run is for; the
        // approval reached the credentials for exactly that target.
        expect(spies.getCredentialsForServerUrl).toHaveBeenCalledWith('https://relay.example.test', { serverId: 'custom-2' });
        expect(bridge.responses.map((response) => response.answer)).toEqual([{ approved: false, reason: 'credentials_unavailable' }]);
    });

    it('takes the panel away when the human declines an override CLI, instead of looping on Retry', async () => {
        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('panel');

        await emitSetupPrompt(pairingPrompt('override', '/repo/apps/cli/bin/happier.mjs'));

        expect(bridge.responses.map((response) => response.answer)).toEqual([{ approved: false, reason: 'cli_not_approved' }]);
        const asked = modal.calls.filter((call) => call.title === 'setupSurface.cliTrustTitle');
        expect(asked).toHaveLength(1);
        expect(asked[0]?.body).toContain('/repo/apps/cli/bin/happier.mjs');
        // Setup is deferred, not retried: the panel steps aside and the drift banner carries it.
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('takes the panel away when the one-CLI question is dismissed, and keeps it for an answer (R12)', async () => {
        const prompt: SetupCliChoicePromptPayload = {
            command: '/usr/local/bin/happier',
            version: '0.2.13',
            origin: 'npm',
            removalCommand: 'npm uninstall -g @happier-dev/cli',
            updateCommand: 'npm install -g @happier-dev/cli@latest',
            belowSetupFloor: false,
            missing: false,
            keepBlockedBy: null,
        };
        modal.alertPress = ['setupSurface.cliChoiceKeep'];
        await renderGate();
        await emitSetupPrompt(createSetupCliChoicePromptData(prompt));

        expect(bridge.responses.map((response) => response.answer)).toEqual([{ choice: 'own' }]);
        const asked = modal.calls.find((call) => call.title.startsWith('setupSurface.cliChoiceTitle'));
        expect(asked?.title).toContain('0.2.13');
        expect(asked?.body).toContain('/usr/local/bin/happier');
        expect(observedGate?.snapshot.presentation).toBe('panel');

        modal.alertPress = [];
        await emitSetupPrompt(createSetupCliChoicePromptData(prompt));
        expect(bridge.responses.map((response) => response.answer)).toEqual([{ choice: 'own' }, { choice: null }]);
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('keeps the setup panel when the human approves the override CLI', async () => {
        modal.confirm['setupSurface.cliTrustTitle'] = true;

        await renderGate();
        await emitSetupPrompt(pairingPrompt('override', '/repo/apps/cli/bin/happier.mjs'));

        // Approved past the human question: the pairing went on to the credentials.
        expect(bridge.responses.map((response) => response.answer)).toEqual([{ approved: false, reason: 'credentials_unavailable' }]);
        expect(observedGate?.snapshot.presentation).toBe('panel');
    });
});

describe('DesktopLocalSetupRuntime — the lifecycle runs at the shell, the Home only presents it (R11)', () => {
    beforeEach(async () => {
        await resetHarness();
        // The moment right after signing in, before anything about this computer is known.
        state.authenticatedThisRun = true;
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderShell(home: boolean) {
        const element = (withHome: boolean) => React.createElement(
            React.Fragment,
            null,
            React.createElement(DesktopLocalSetupRuntime),
            withHome ? React.createElement(DesktopLocalSetupPanel) : null,
        );
        const screen = await renderScreen(element(home));
        await settle();
        return {
            screen,
            showHome: async (withHome: boolean) => {
                await screen.update(element(withHome));
                await settle(2);
            },
        };
    }

    it('starts setup with no Home on screen, and the Home presents that same run whenever it is shown', async () => {
        // A cold deep link (a session, settings, the inbox) never renders the Home route.
        const launches = spyOnLaunchPaths();
        const { screen, showHome } = await renderShell(false);
        expect(launches.startSetup).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('desktop-setup-panel:veil')).toBeNull();

        await showHome(true);
        expect(screen.findByTestId('desktop-setup-panel:veil')).not.toBeNull();

        // Leaving the Home and coming back neither restarts nor duplicates the lifecycle.
        await showHome(false);
        await showHome(true);
        expect(launches.startSetup).toHaveBeenCalledTimes(1);
        expect(startsOf('setup.thisComputer.v1')).toHaveLength(1);
        expect(screen.findByTestId('desktop-setup-panel:veil')).not.toBeNull();
    });

    it('shows nothing on the Home once the machine is proved ready, and nothing at all without a lifecycle', async () => {
        answerStatus(READY_INSPECTION);
        const { screen } = await renderShell(true);
        expect(spies.machineRpc).toHaveBeenCalled();
        const panel = screen.findByTestId('desktop-setup-panel:veil');
        // Proved ready: nothing to present (at most the panel's own departure beat).
        expect(panel == null || panel.props.pointerEvents === 'none').toBe(true);

        standardCleanup();
        const bare = await renderScreen(React.createElement(DesktopLocalSetupPanel));
        expect(bare.findByTestId('desktop-setup-panel:veil')).toBeNull();
    });
});
