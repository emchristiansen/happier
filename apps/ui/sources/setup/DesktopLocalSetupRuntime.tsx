import * as React from 'react';

import { useCliUpdateTask } from '@/components/settings/machines/localControl/useCliUpdateTask';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import { readKeptCliUpdateCommand } from './deriveDesktopLocalSetupSnapshot';
import { resolveAppAccountLabel } from './thisComputerLabels';
import type { SetupLocalFacts } from './setupStageModel';
import { useDesktopLocalSetupGate } from './useDesktopLocalSetupGate';

/**
 * What the Home's setup panel presents: the lifecycle's own facts and actions, nothing derived a
 * second time. `visible` is the pure snapshot's presentation; the panel adds only its departure.
 */
export type DesktopLocalSetupPanelModel = Readonly<{
    visible: boolean;
    run: SystemTaskRunState | null;
    /** The ambient inspection's task while it is still reading, for its byte samples. */
    inspectionTaskId: string | null;
    facts: SetupLocalFacts;
    retry: () => void;
    continueWithoutThisComputer: () => void;
    updateCli: () => void;
    updatingCli: boolean;
}>;

/**
 * The one published model. The runtime is its only writer and the Home panel its only reader, so
 * the panel can come and go with the route while the lifecycle keeps running at the shell.
 */
let publishedModel: DesktopLocalSetupPanelModel | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of Array.from(listeners)) listener();
}

function publish(next: DesktopLocalSetupPanelModel | null): void {
    if (publishedModel === next) return;
    publishedModel = next;
    notify();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function readModel(): DesktopLocalSetupPanelModel | null {
    return publishedModel;
}

/** The lifecycle's current presentation, or `null` when no lifecycle is mounted (signed out, web). */
export function useDesktopLocalSetupPanelModel(): DesktopLocalSetupPanelModel | null {
    return React.useSyncExternalStore(subscribe, readModel, readModel);
}

/**
 * How many Home panels are presenting the lifecycle right now. The Home renders one; a route that
 * does not render the Home has none, so "the panel is showing" means it is actually on screen.
 */
let presentingPanels = 0;

function readPanelShowing(): boolean {
    return presentingPanels > 0 && publishedModel?.visible === true;
}

/**
 * R11 — while the Home panel is on screen it is the one owner of "this computer": other surfaces
 * beside it (the Home guidance card, in every layout) do not repeat its call to action. The answer
 * is the lifecycle's own `visible` plus the panel's presence, never a second reading of the facts.
 */
export function useDesktopLocalSetupPanelShowing(): boolean {
    return React.useSyncExternalStore(subscribe, readPanelShowing, readPanelShowing);
}

/** Held by `DesktopLocalSetupPanel` while it presents the lifecycle. */
export function usePresentDesktopLocalSetupPanel(presenting: boolean): void {
    React.useLayoutEffect(() => {
        if (!presenting) return;
        presentingPanels += 1;
        notify();
        return () => {
            presentingPanels -= 1;
            notify();
        };
    }, [presenting]);
}

/**
 * R11 — the ONE desktop setup lifecycle, mounted once at the authenticated desktop shell (root
 * layout), so every launch gets the same inspection, quiet start, reconciliation, executor and
 * readiness proof whichever route it opens on: the Home, a session deep link, Settings, the inbox.
 *
 * It renders nothing and blocks nothing. Its presentation lives on the Home
 * (`DesktopLocalSetupPanel`); consent questions are the existing focused alerts, raised by the
 * operation that needs them. The R17 Update runs here too, so an update started from the panel
 * still retries setup when it finishes on another route.
 */
export function DesktopLocalSetupRuntime(): null {
    const gate = useDesktopLocalSetupGate({ enabled: true });
    const cliUpdate = useCliUpdateTask({ onSucceeded: gate.retry });

    const relayDisplayName = toRelayHostDisplay(getActiveServerSnapshot().serverUrl);
    const appAccountId = getActiveServerAccountScope()?.accountId ?? null;
    const accountLabel = appAccountId ? resolveAppAccountLabel(appAccountId) : null;

    // Retry drops the previous setup failure immediately. The panel can still show actual
    // acquisition work from the inspection task, whose success never means setup succeeded.
    const run = gate.inspection.status === 'pending' ? null : gate.setupTask.activeTaskSnapshot;
    // The code chooses the sentence and the message is the diagnostic behind Details, so the
    // failed inspection travels as both rather than as one raw string doing two jobs. A `start()`
    // rejection carries no code of its own, so it takes the one the coordinator already uses for
    // the same class of failure.
    const inspectionError = gate.snapshot.reason === 'inspection_failed' && gate.inspection.status === 'failed'
        ? gate.inspection.error
        : null;
    const startError = gate.setupTask.startError;
    // A settled proof failure is named, so the panel says which one happened and offers a Retry
    // instead of spinning on a run that already finished (INV8/INV10).
    const verification = gate.verification.status === 'blocked' ? gate.verification.code : 'pending';
    const taskParams = gate.setupTask.activeTaskSpec?.params;
    const runMatchesTarget = taskParams !== null && typeof taskParams === 'object'
        && 'activeRelayUrl' in taskParams && 'expectedAccountId' in taskParams
        && taskParams.activeRelayUrl === getActiveServerSnapshot().serverUrl
        && taskParams.expectedAccountId === appAccountId;
    const operationNeedsPresentation = runMatchesTarget && !gate.setupRunDismissed
        && (gate.setupTask.isStarting || (run != null && run.result?.ok !== true));
    const visible = gate.snapshot.presentation === 'panel' || operationNeedsPresentation;
    const relayMove = run != null && gate.setupRunMovesRelay === true;
    const inspectionTaskId = gate.inspection.status !== 'resolved' ? gate.inspectionTaskId ?? null : null;
    const cliChannel = gate.inspection.status === 'resolved' ? gate.inspection.facts.acquisition.channel : null;
    const cliLatestVersion = gate.inspection.status === 'resolved' ? gate.inspection.facts.cliUpdate?.latestVersion ?? null : null;
    const ownCliUpdateCommand = gate.inspection.status === 'resolved' ? readKeptCliUpdateCommand(gate.inspection.facts) : null;

    const model = React.useMemo<DesktopLocalSetupPanelModel>(() => ({
        visible,
        run,
        inspectionTaskId,
        facts: {
            relayDisplayName,
            accountLabel,
            entry: run == null ? 'checking' : 'setup',
            relayMove,
            verification,
            startFailure: inspectionError
                ?? (startError ? { code: 'system_task_start_failed', message: startError } : null),
            // RV-7 — a failed Update says why in the panel's one sentence, with Update still the action.
            cliUpdateFailure: cliUpdate.errorMessage,
            cliChannel,
            cliLatestVersion,
            ownCliUpdateCommand,
        },
        retry: gate.retry,
        continueWithoutThisComputer: gate.continueWithoutThisComputer,
        updateCli: cliUpdate.start,
        updatingCli: cliUpdate.running,
    }), [
        accountLabel,
        cliChannel,
        cliLatestVersion,
        ownCliUpdateCommand,
        relayMove,
        cliUpdate.errorMessage,
        cliUpdate.running,
        cliUpdate.start,
        gate.continueWithoutThisComputer,
        gate.retry,
        inspectionError,
        inspectionTaskId,
        relayDisplayName,
        run,
        startError,
        verification,
        visible,
    ]);

    React.useLayoutEffect(() => {
        publish(model);
    }, [model]);
    React.useEffect(() => () => publish(null), []);
    return null;
}
