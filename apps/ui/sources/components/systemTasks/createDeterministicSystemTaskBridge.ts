import {
    createSetupPairingPromptData,
    SYSTEM_TASK_PROTOCOL_VERSION,
    type SystemTaskResult,
    type SystemTaskSpec,
} from '@happier-dev/protocol';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';

import type {
    SystemTaskBridgeListenerSet,
    SystemTasksBridge,
} from './types';

export type DeterministicScenarioStep =
    | Readonly<{
        delayMs: number;
        type: 'event';
        payload: Record<string, unknown>;
    }>
    /**
     * Emits a prompt event and then holds the scenario until `respond` answers it, exactly as the
     * interactive hsetup runner holds `ctx.prompt()`. An answer of `{ approved: true }` resumes the
     * remaining steps; anything else fails the task with `pairing_declined`.
     */
    | Readonly<{
        delayMs: number;
        type: 'prompt';
        payload: Record<string, unknown>;
    }>
    | Readonly<{
        delayMs: number;
        type: 'result';
        payload: SystemTaskResult;
    }>;

type BridgeListenerSet = Readonly<{
    taskId: string;
}> & SystemTaskBridgeListenerSet;

type TaskRuntime = {
    timeouts: Set<ReturnType<typeof setTimeout>>;
    completed: boolean;
    /** Steps held behind an unanswered prompt, with their delays relative to the prompt. */
    heldSteps: readonly DeterministicScenarioStep[] | null;
};

/**
 * A fixed 32-byte public key standing in for the CLI's ephemeral pairing key in dev/test mode.
 * Any 32 bytes is a valid Curve25519 point for `box`, so the app's real sealing path runs
 * unchanged against it; nothing is ever opened with it.
 */
/** The command a simulated managed install would have produced; never spawned. */
const SIMULATED_MANAGED_CLI_COMMAND = 'happier';

const SIMULATED_TERMINAL_PUBLIC_KEY_B64URL = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

function readStringParam(params: SystemTaskSpec['params'], key: string): string {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return '';
    }
    const value = (params as Record<string, unknown>)[key];
    return typeof value === 'string' ? value.trim() : '';
}

function buildDefaultScenario(spec: SystemTaskSpec, taskId: string): readonly DeterministicScenarioStep[] {
  const taskKind = spec.kind;
    if (taskKind === 'daemon.service.status.v1') {
        return [
            {
                delayMs: 30,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        serviceInstalled: true,
                        daemonRunning: true,
                        needsAuth: false,
                        machineId: 'machine-local-1',
                        // The simulated daemon is already on the app's relay and account, so the
                        // dev-mode entry decision is "ready" and the simulated setup only runs on demand.
                        acquisition: { command: '/simulated/happier', provenance: 'managed' },
                        server: {
                            activeServerId: 'simulated',
                            serverUrl: getActiveServerSnapshot().serverUrl || null,
                            publicServerUrl: getActiveServerSnapshot().serverUrl || null,
                            localServerUrl: null,
                            comparableKey: null,
                        },
                        auth: {
                            authenticated: true,
                            machineRegistered: true,
                            machineId: 'machine-local-1',
                            needsAuth: false,
                            accountId: getActiveServerAccountScope()?.accountId ?? null,
                            credentialState: 'valid',
                            validatedAccountId: getActiveServerAccountScope()?.accountId ?? null,
                        },
                        service: { installed: true, running: true },
                        daemon: { running: true, startedWithCliVersion: 'simulated', serviceManaged: true, serviceLabel: 'simulated' },
                        runtimeConvergence: {
                            controlReachable: true,
                            serviceOwnsRunningDaemon: true,
                            machineIdMatches: true,
                            cliVersionMatches: true,
                        },
                        // R16 — the executor's one list of this computer's services.
                        serviceRows: getActiveServerSnapshot().serverUrl
                            ? [{ relayUrl: getActiveServerSnapshot().serverUrl, state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] }]
                            : [],
                        pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] },
                        // The producer's aggregates over the managed services (one running, mode undeclared).
                        runningManagedServiceCount: 1,
                        managedServiceAutostart: null,
                    },
                },
            },
        ];
    }
    if (taskKind === 'daemon.service.start.v1') {
        return [
            {
                delayMs: 30,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 30,
                    type: 'step',
                    stepId: 'task.step.prepare',
                    message: t('settings.systemTaskStepPrepare'),
                },
            },
            {
                delayMs: 120,
                type: 'event',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 120,
                    type: 'progress',
                    stepId: 'task.step.finish',
                    message: t('settings.systemTaskStepFinish'),
                },
            },
            {
                delayMs: 180,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        serviceInstalled: true,
                        daemonRunning: true,
                        needsAuth: false,
                        machineId: 'machine-local-1',
                    },
                },
            },
        ];
    }
    if (taskKind === 'setup.thisComputer.v1') {
        // Mirrors the interactive executor's R12 order so the surface's stage model, the
        // approval exchange and the end-to-end test all run against the real sequence.
        const progress = (delayMs: number, stepId: string, message: string): DeterministicScenarioStep => ({
            delayMs,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: delayMs,
                type: 'progress',
                stepId,
                message,
            },
        });
        const relayUrl = readStringParam(spec.params, 'activeRelayUrl');
        return [
            progress(30, 'setup.thisComputer.ensureCli', t('settings.machineSetupStageInstall')),
            progress(60, 'setup.thisComputer.inspectService', t('settings.machineSetupStageConnect')),
            progress(90, 'setup.thisComputer.configureRelay', t('settings.machineSetupStageConnect')),
            progress(120, 'setup.thisComputer.checkAuth', t('settings.machineSetupStageConnect')),
            {
                delayMs: 150,
                type: 'prompt',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    tsMs: 150,
                    type: 'prompt',
                    stepId: 'setup.thisComputer.auth.request',
                    message: t('settings.machineSetupTaskWaitingForInput'),
                    // Public material only, built through the same shared contract the real
                    // executor uses, so a simulated run cannot drift from the live prompt.
                    data: createSetupPairingPromptData({
                        publicKeyB64Url: SIMULATED_TERMINAL_PUBLIC_KEY_B64URL,
                        relayUrl,
                        serverIdentityKey: createServerUrlComparableKey(relayUrl),
                        // The account the spec asked this run to pair for, exactly as the real
                        // executor echoes it — the app refuses a prompt bound to another account.
                        accountId: readStringParam(spec.params, 'expectedAccountId'),
                        pairingRequirement: 'compatible',
                        cliProvenance: 'managed',
                        // A simulated run stands in for a desktop-managed install, so the app
                        // approves it silently exactly as it would on a real one.
                        cliCommand: SIMULATED_MANAGED_CLI_COMMAND,
                    }),
                },
            },
            progress(180, 'setup.thisComputer.auth.wait', t('settings.machineSetupStageConnect')),
            progress(210, 'setup.thisComputer.installService', t('settings.machineSetupStageInstall')),
            progress(240, 'setup.thisComputer.startService', t('settings.machineSetupStageInstall')),
            {
                delayMs: 270,
                type: 'result',
                payload: {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: true,
                    data: {
                        simulated: true,
                        kind: taskKind,
                        machineId: 'machine-local-1',
                        relayUrl,
                        cliProvenance: 'managed',
                        relayChanged: true,
                        credentialsChanged: true,
                        serviceAction: 'install',
                        pathExposure: { changed: true, shellReloadHint: 'Open a new terminal to use happier.', failure: null },
                    },
                },
            },
        ];
    }

    return [
        {
            delayMs: 30,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 30,
                type: 'step',
                stepId: 'task.step.prepare',
                message: t('common.loading'),
            },
        },
        {
            delayMs: 90,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 90,
                type: 'progress',
                stepId: 'task.step.installRuntime',
                message: t('settings.machineSetupStageInstall'),
            },
        },
        {
            delayMs: 150,
            type: 'event',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: 150,
                type: 'progress',
                stepId: 'task.step.finish',
                message: t('settings.machineSetupStageFinish'),
            },
        },
        {
            delayMs: 210,
            type: 'result',
            payload: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    simulated: true,
                    kind: taskKind,
                },
            },
        },
    ];
}

function isApprovedAnswer(answer: unknown): boolean {
    return Boolean(answer)
        && typeof answer === 'object'
        && (answer as { approved?: unknown }).approved === true;
}

export function createDeterministicSystemTaskBridge(options?: Readonly<{
    buildScenario?: (spec: SystemTaskSpec, taskId: string) => readonly DeterministicScenarioStep[];
}>): SystemTasksBridge {
    const listeners = new Set<BridgeListenerSet>();
    const runtimes = new Map<string, TaskRuntime>();
    let nextTaskId = 1;

    const notifyEvent = (taskId: string, payload: unknown) => {
        for (const listener of listeners) {
            if (listener.taskId === taskId) {
                listener.onEvent(payload);
            }
        }
    };

    const notifyResult = (taskId: string, payload: unknown) => {
        for (const listener of listeners) {
            if (listener.taskId === taskId) {
                listener.onResult(payload);
            }
        }
    };

    const clearRuntime = (taskId: string) => {
        const runtime = runtimes.get(taskId);
        if (!runtime) {
            return;
        }
        for (const timeoutId of runtime.timeouts) {
            clearTimeout(timeoutId);
        }
        runtimes.delete(taskId);
    };

    const completeWithResult = (taskId: string, runtime: TaskRuntime, payload: SystemTaskResult) => {
        runtime.completed = true;
        notifyResult(taskId, payload);
        clearRuntime(taskId);
    };

    /**
     * Schedules the steps up to and including the first prompt at their `delayMs` offsets. When
     * that prompt fires, the steps after it are held (re-based to the prompt's offset) until
     * `respond` releases them, at which point the remainder is scheduled the same way.
     */
    const scheduleSteps = (taskId: string, runtime: TaskRuntime, steps: readonly DeterministicScenarioStep[]) => {
        const promptIndex = steps.findIndex((step) => step.type === 'prompt');
        const segment = promptIndex === -1 ? steps : steps.slice(0, promptIndex + 1);
        for (const step of segment) {
            const timeoutId = setTimeout(() => {
                runtime.timeouts.delete(timeoutId);
                if (runtime.completed) {
                    return;
                }
                if (step.type === 'event') {
                    notifyEvent(taskId, step.payload);
                    return;
                }
                if (step.type === 'prompt') {
                    runtime.heldSteps = steps
                        .slice(promptIndex + 1)
                        .map((held) => ({ ...held, delayMs: Math.max(0, held.delayMs - step.delayMs) }));
                    notifyEvent(taskId, step.payload);
                    return;
                }
                completeWithResult(taskId, runtime, step.payload);
            }, step.delayMs);
            runtime.timeouts.add(timeoutId);
        }
    };

    return {
        async start(spec) {
            const taskId = `task_${nextTaskId++}`;
            const runtime: TaskRuntime = {
                timeouts: new Set(),
                completed: false,
                heldSteps: null,
            };
            runtimes.set(taskId, runtime);

            scheduleSteps(taskId, runtime, (options?.buildScenario ?? buildDefaultScenario)(spec, taskId));

            return taskId;
        },
        async cancel(taskId) {
            const runtime = runtimes.get(taskId);
            if (!runtime || runtime.completed) {
                return;
            }
            completeWithResult(taskId, runtime, {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: false,
                error: {
                    code: 'cancelled',
                    message: 'Task cancelled',
                },
            });
        },
        async respond(taskId, answer) {
            const runtime = runtimes.get(taskId);
            if (!runtime || runtime.completed || !runtime.heldSteps) {
                return;
            }
            const held = runtime.heldSteps;
            runtime.heldSteps = null;
            if (!isApprovedAnswer(answer)) {
                completeWithResult(taskId, runtime, {
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                    taskId,
                    ok: false,
                    error: {
                        code: 'pairing_declined',
                        message: 'The pairing request was not approved.',
                    },
                });
                return;
            }
            scheduleSteps(taskId, runtime, held);
        },
        async subscribe(taskId, listenersForTask) {
            const listener = { taskId, ...listenersForTask };
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
