import type { SystemTaskSpec } from '@happier-dev/protocol';

import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { awaitSystemTaskResult } from '@/components/systemTasks/awaitSystemTaskResult';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

/**
 * The background-service commands the desktop app issues on its own behalf: the installed
 * services' autostart mode, starting them as the app opens, and stopping them as the app quits.
 * Each command covers every service the app manages — the default-following one and each relay's
 * own pinned service (one login-start setting governs them all; bootstrap applies it to each).
 *
 * Both are the CLI's commands — bootstrap sequences them and re-reads the result, and nothing
 * here restates a service rule (INV9). This module exists so the settings toggle and the app-close
 * guard issue them through one place instead of each wiring the runner.
 */
/** A service command bootstrap refused or failed, with its named code kept for callers that branch on it. */
export class BackgroundServiceTaskError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message || code);
        this.name = 'BackgroundServiceTaskError';
        this.code = code;
    }
}

async function runLocalServiceTask(spec: SystemTaskSpec, runner: SystemTaskRunner): Promise<void> {
    const taskId = await runner.start(spec);
    const result = await awaitSystemTaskResult(runner, taskId);
    if (!result.ok) {
        throw new BackgroundServiceTaskError(result.error.code, result.error.message);
    }
}

export async function setBackgroundServiceAutostart(
    autostart: DesktopBackgroundServiceAutostartMode,
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(
        buildLocalDaemonServiceSystemTaskSpec('daemon.service.autostart.set.v1', { autostart }),
        runner,
    );
}

/**
 * Starts the installed service, which is how "it answers while the app is open" is kept for an
 * on-demand service the app-close guard stopped (H6). It is the same CLI command the settings row
 * uses; the gate runs it as a check rather than as setup, because nothing about this computer
 * needs configuring — the service is already installed for this relay and account.
 */
export async function startBackgroundService(
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(buildLocalDaemonServiceSystemTaskSpec('daemon.service.start.v1'), runner);
}

/**
 * H3/N2 — this computer stops answering on `relayUrl`: the service the app installed for that relay
 * is uninstalled through the CLI, which decides from this computer's own inventory (bootstrap
 * proves the removal by listing again; nothing serving the relay is a no-op). `userOwned` when the
 * relay's service here was set up outside Happier and was left as it is. Rejects on any other
 * failure, so a caller that must not go on without it — removing the relay — can stop.
 */
export async function disconnectThisComputerFromRelay(
    relayUrl: string,
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<Readonly<{ userOwned: boolean }>> {
    try {
        await runLocalServiceTask(buildLocalDaemonServiceSystemTaskSpec('daemon.service.relay.disconnect.v1', { relayUrl }), runner);
        return { userOwned: false };
    } catch (error) {
        if (error instanceof BackgroundServiceTaskError && error.code === 'service_user_owned') {
            return { userOwned: true };
        }
        throw error;
    }
}

export async function stopBackgroundService(
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(buildLocalDaemonServiceSystemTaskSpec('daemon.service.stop.v1'), runner);
}
