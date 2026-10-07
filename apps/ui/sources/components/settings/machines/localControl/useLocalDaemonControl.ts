import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { presentSetupServiceConsent } from '@/setup/presentSetupServiceConsent';
import { presentUnmanagedCliConsent } from '@/setup/presentUnmanagedCliConsent';
import { resolveThisComputerServiceForActiveRelay } from '@/setup/desktopSetupCoordinator';
import { listThisComputerRelayRows } from '@/setup/thisComputerRelayRows';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { t } from '@/text';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';
import { decorateLocalControlSnapshot } from '@/components/settings/server/localControl/decorateLocalControlSnapshot';

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

/** The named reasons of `daemon.service.start.v1`'s per-service outcomes that failed, or `null`. */
function readFailedStartTargets(data: unknown): string | null {
    const targets = data && typeof data === 'object' ? (data as { targets?: unknown }).targets : undefined;
    if (!Array.isArray(targets)) {
        return null;
    }
    const messages = targets.flatMap((entry) => {
        const record = entry && typeof entry === 'object' ? entry as { outcome?: unknown; message?: unknown; code?: unknown } : {};
        if (record.outcome !== 'failed') return [];
        const message = typeof record.message === 'string' && record.message.trim() ? record.message.trim() : typeof record.code === 'string' ? record.code : null;
        return message ? [message] : [];
    });
    return messages.length > 0 ? messages.join('\n') : null;
}

export function useLocalDaemonControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const activeServerSnapshot = getActiveServerSnapshot();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [startTaskId, setStartTaskId] = React.useState<string | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const handledStartResultTaskIdRef = React.useRef<string | null>(null);

    const startSnapshot = useSystemTaskSnapshot(runner, startTaskId);

    // The one ambient inspection every desktop surface reads (F6). This row used to start its own
    // `daemon.service.status.v1` with its own projection beside the coordinator's, so the gate and
    // the row could describe the same computer differently, and a fresh read by either reached
    // neither the other nor the drift banner rendered beside it.
    // Opening this section is looking at this computer, so it re-reads once (R17: an update the
    // daily background check found since app open shows here).
    const { inspection, refresh: refreshStatus } = useDesktopLocalInspection(!isUnavailable, { refreshOnOpen: true });
    // The account this repair is for, read from the same owner the executor spec is built from, so
    // the app never approves a pairing bound to a different account (INV2).
    const expectedAccountId = getActiveServerAccountScope()?.accountId ?? null;
    // This section describes the daemon that answers for the app's relay — its own pinned service
    // when it has one here (one daemon per relay), else the default-following one.
    const service = resolveThisComputerServiceForActiveRelay(inspection);
    const facts = service?.facts ?? null;
    // This computer's one command line, whichever service reports it — still known when the app
    // relay's own service could not be read (its machine and account then stay unknown).
    const cliFacts = facts ?? (inspection.status === 'resolved' ? inspection.facts : null);
    // C5 — every relay this computer has a service for, from the one projection the connection
    // popover and the tray render, so Settings never describes this computer by a rule of its own.
    const activeRelayUrl = activeServerSnapshot.serverUrl;
    const activeLocalRelayUrl = activeServerSnapshot.activeLocalRelayUrl ?? null;
    const relayRows = React.useMemo(() => listThisComputerRelayRows(
        inspection,
        activeRelayUrl ? { relayUrl: activeRelayUrl, localRelayUrl: activeLocalRelayUrl, accountId: expectedAccountId } : null,
    ), [activeLocalRelayUrl, activeRelayUrl, expectedAccountId, inspection]);
    const inspectionErrorMessage = inspection.status === 'failed' ? (inspection.error.message || inspection.error.code) : null;
    const setupTask = useThisComputerSetupTask({
        runner,
        ...(expectedAccountId
            ? {
                authRequestApproval: {
                    expectedRelayUrl: activeServerSnapshot.serverUrl,
                    expectedAccountId,
                    serverId: activeServerSnapshot.serverId,
                },
            }
            : {}),
        onServiceConsentRequired: presentSetupServiceConsent,
        onUnmanagedCliConsentRequired: presentUnmanagedCliConsent,
    });
    const repairSnapshot = setupTask.activeTaskSnapshot;

    const runAction = React.useCallback(async (kind: 'daemon.service.start.v1') => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStartTaskId(taskId);
            handledStartResultTaskIdRef.current = null;
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [isUnavailable, runner]);

    const startDaemonService = React.useCallback(async () => {
        await runAction('daemon.service.start.v1');
    }, [runAction]);

    const startSetupTask = setupTask.start;
    // Repair and R12's "change who manages the command line" are the same setup run; the change
    // only asks the executor to put the one-CLI question again.
    const runSetup = React.useCallback(async (options: Readonly<{ reconsiderCli?: boolean }> = {}) => {
        if (isUnavailable || !activeServerSnapshot.serverUrl) {
            return null;
        }
        try {
            const taskId = await startSetupTask(options);
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [activeServerSnapshot.serverUrl, isUnavailable, startSetupTask]);
    const repairBackgroundService = React.useCallback(async () => await runSetup(), [runSetup]);
    const changeCommandLine = React.useCallback(async () => await runSetup({ reconsiderCli: true }), [runSetup]);

    React.useEffect(() => {
        if (!startSnapshot?.result || handledStartResultTaskIdRef.current === startSnapshot.taskId) {
            return;
        }

        handledStartResultTaskIdRef.current = startSnapshot.taskId;
        if (!startSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(startSnapshot.result));
            return;
        }

        // N3 — a start that brought some service up can still have failed for another; the named
        // reason for each one that did not start is what this row owes the person who pressed it.
        setLastErrorMessage(readFailedStartTargets(startSnapshot.result.data));
        refreshStatus();
    }, [refreshStatus, startSnapshot]);

    React.useEffect(() => {
        if (!repairSnapshot?.result || repairSnapshot.result.ok) {
            return;
        }
        setLastErrorMessage(readErrorMessage(repairSnapshot.result));
    }, [repairSnapshot]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = repairSnapshot?.result ? null : repairSnapshot ?? (startSnapshot?.result ? null : startSnapshot);
        return snapshot ? decorateLocalControlSnapshot(snapshot) : null;
    }, [repairSnapshot, startSnapshot]);

    const activeTaskTitle = React.useMemo(() => {
        if (repairSnapshot && repairSnapshot.result == null) {
            return t('server.relayDrift.progressTitle');
        }
        if (startSnapshot && startSnapshot.result == null) {
            return t('machine.daemon');
        }
        return null;
    }, [repairSnapshot, startSnapshot]);

    // `isStarting` covers the window where the coordinator is still waiting on the one ambient
    // inspection before it hands the executor spec over, so the row cannot be pressed twice.
    const isBusy = setupTask.isStarting || (activeTaskSnapshot != null && activeTaskSnapshot.result == null);
    // What the Start row acts on: a service that exists here and is not running. It is deliberately
    // NOT a readiness test — readiness is `verifyCurrentTarget` alone (INV8/INV10), and the flat
    // `installed && running && !needsAuth` that used to live here was a third, weaker definition of
    // it that also disabled the one action that could fix an unpaired service.
    // `daemon.service.start.v1` starts the default-following service; a pinned one is brought up by
    // the repair (the setup run for its relay), which is always offered below.
    const canStart = !isUnavailable && !isBusy
        && service?.serviceTargetMode === 'default-following'
        && facts?.service.installed === true && facts.service.running !== true;
    const canRepair = !isUnavailable && !isBusy && Boolean(activeServerSnapshot.serverUrl);

    const cancelRepair = setupTask.cancel;
    return {
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        lastErrorMessage: lastErrorMessage ?? inspectionErrorMessage,
        refreshStatus,
        repairBackgroundService,
        changeCommandLine,
        startDaemonService,
        facts,
        cliFacts,
        relayRows,
        isBusy,
        isUnavailable,
        cancel: React.useCallback(() => {
            if (repairSnapshot && repairSnapshot.result == null) {
                cancelRepair();
                return;
            }
            if (startSnapshot && startSnapshot.result == null && startTaskId) {
                void runner.cancel(startTaskId);
            }
        }, [cancelRepair, repairSnapshot, runner, startSnapshot, startTaskId]),
    };
}
