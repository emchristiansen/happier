import * as React from 'react';
import {
    parseSetupAccountConsentPromptData,
    parseSetupCliChoicePromptData,
    parseSetupServiceConsentPromptData,
    type SetupCliChoice,
    type SetupCliChoicePromptPayload,
    type SetupServiceConsentPromptPayload,
    type SystemTaskEvent,
    type SystemTaskResult,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

import {
    approveSetupPairingForTarget,
    readSetupPairingPrompt,
    type SetupPairingApprovalTarget,
    type SetupUnmanagedCliDecision,
} from '@/auth/terminal/approveSetupPairingForTarget';

import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { presentRelayReconciliationConsent } from '@/setup/presentRelayReconciliationConsent';
import type { RelayReconciliationConsentAnswer, ThisComputerMoveRequest } from '@/setup/presentRelayReconciliationConsent';
import { resolveAppAccountLabel, resolveDaemonAccountLabel } from '@/setup/thisComputerLabels';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import { getSystemTasksRunner } from './systemTasksRuntime';
import { useSystemTaskSnapshot } from './useSystemTaskSnapshot';
import type { SystemTaskRunState, SystemTaskRunner } from './types';

/**
 * What the person can still do about a failed setup run, when it is something the app can offer.
 * Today that is exactly one thing: authenticate this relay. A pairing that could not complete has
 * no separate follow-up — the app approves the pairing itself (UD3/R4), so there is nothing for a
 * human to approve anywhere.
 */
export type ThisComputerSetupFollowUp = 'auth' | null;

/**
 * Explicit-target approval configuration for the setup task's pairing prompt: the relay and the
 * account the app sent the executor, plus the app's profile id for that relay (credential scope).
 * The focused relay is never consulted, and a caller that cannot name both relay and account gets
 * no approval. Install ownership is deliberately absent — it rides the live prompt, which
 * describes the CLI actually asking.
 */
export type ThisComputerSetupAuthRequestApproval = SetupPairingApprovalTarget;

/**
 * What the executor learned from `happier service install --dry-run --json` and needs a decision
 * on (INV9). Presented, never re-evaluated, by the UI. The payload shape and its parsing live in
 * `@happier-dev/protocol`'s setup task contract, which the executor builds through.
 */
export type SetupServiceConsentPrompt = SetupServiceConsentPromptPayload & Readonly<{ taskId: string }>;

export function readSetupServiceConsentPrompt(event: SystemTaskEvent): SetupServiceConsentPrompt | null {
    if (event.type !== 'prompt') return null;
    const payload = parseSetupServiceConsentPromptData(event.data);
    return payload ? { taskId: event.taskId, ...payload } : null;
}

export function resolveThisComputerSetupFollowUp(result: SystemTaskResult | null): ThisComputerSetupFollowUp {
    if (!result || result.ok) {
        return null;
    }
    if (result.error.code === 'not_authenticated') {
        return 'auth';
    }
    return null;
}

/**
 * D1 — the executor's account question, as the one account-move request the app already asks
 * with: the account the target relay's credentials belong to, the one the app is signed in as,
 * and the relay both are on.
 */
export function readSetupAccountConsentRequest(event: SystemTaskEvent): Extract<ThisComputerMoveRequest, { kind: 'account' }> | null {
    if (event.type !== 'prompt') return null;
    const payload = parseSetupAccountConsentPromptData(event.data);
    if (!payload) return null;
    return {
        kind: 'account',
        fromAccountLabel: resolveDaemonAccountLabel({ accountLabel: payload.currentAccountLabel, validatedAccountId: payload.currentAccountId }) ?? '',
        toAccountLabel: resolveAppAccountLabel(payload.expectedAccountId),
        relayHost: toRelayHostDisplay(payload.relayUrl),
        fromRelayHost: null,
    };
}

/** R12 — the executor's one-CLI question, or `null` for any other event. */
export function readSetupCliChoicePrompt(event: SystemTaskEvent): SetupCliChoicePromptPayload | null {
    return event.type === 'prompt' ? parseSetupCliChoicePromptData(event.data) : null;
}

/** The canonical one-CLI question, loaded when it is actually asked. */
async function presentCliChoiceDefault(prompt: SetupCliChoicePromptPayload): Promise<SetupCliChoice | null> {
    const { presentCliChoice } = await import('@/setup/presentCliChoice');
    return await presentCliChoice(prompt);
}

/** What starting a setup run may ask the executor for, beyond the app's explicit target. */
export type ThisComputerSetupStartOptions = Readonly<{
    /** R12 — Settings' change action: ask the one-CLI question again through this same run. */
    reconsiderCli?: boolean;
    /** The shell's direct-selection path uses the same captured prompt/approval operation. */
    reconcile?: boolean;
}>;

/** The canonical account question, loaded when it is actually asked. `true` means move. */
async function presentAccountConsent(request: ThisComputerMoveRequest): Promise<boolean> {
    return (await presentRelayReconciliationConsent(request)) !== 'keep';
}

export function useThisComputerSetupTask(options: Readonly<{
    runner?: SystemTaskRunner;
    onSucceeded?: (snapshot: SystemTaskRunState) => void;
    /**
     * When set, the task's pairing prompt is answered automatically through
     * `approveSetupPairingForTarget`. When absent, a pairing prompt is declined by name rather
     * than left unanswered — nothing in 0.2 can answer it by hand, and an unanswered prompt is a
     * silent hang.
     */
    authRequestApproval?: ThisComputerSetupAuthRequestApproval;
    /**
     * Asks the person at the keyboard whether a CLI this app's install path did not place may be
     * approved. When absent such a CLI is refused by name rather than approved unattended; the
     * desktop-managed case never reaches this callback.
     */
    onUnmanagedCliConsentRequired?: (decision: SetupUnmanagedCliDecision) => Promise<boolean>;
    /**
     * Presents the executor's service-ownership decision (UD5) and resolves with the user's
     * answer. When absent, the prompt is declined by name so the executor stops before mutating
     * anything, rather than waiting forever.
     */
    onServiceConsentRequired?: (prompt: SetupServiceConsentPrompt) => Promise<boolean>;
    /**
     * D1 — the executor found the target relay's credentials signed in as another account and asks
     * before claiming this computer from it. Defaults to the app's one account question, so no
     * surface can start setup without being able to answer it; `true` means move.
     */
    onAccountConsentRequired?: (request: ThisComputerMoveRequest) => Promise<boolean>;
    /**
     * R12 — the executor found a `happier` this app did not install and asks, once, who manages
     * the command line. Defaults to the app's one presenter, so every surface that starts setup
     * can answer it; `null` means the question was dismissed and the run stops unchanged.
     */
    onCliChoiceRequired?: (prompt: SetupCliChoicePromptPayload) => Promise<SetupCliChoice | null>;
    /** The coordinator's consent presenter, supplied by surfaces that must keep the action path loaded. */
    confirm?: (request: ThisComputerMoveRequest) => Promise<RelayReconciliationConsentAnswer>;
}> = {}) {
    const runner = options.runner ?? getSystemTasksRunner();
    const sharedRun = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe, desktopSetupCoordinator.readSetupRun, desktopSetupCoordinator.readSetupRun,
    );
    const isStarting = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe, desktopSetupCoordinator.readSetupStarting, desktopSetupCoordinator.readSetupStarting,
    );
    const startError = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe, desktopSetupCoordinator.readSetupStartError, desktopSetupCoordinator.readSetupStartError,
    );
    const activeTaskId = sharedRun?.runner === runner ? sharedRun.taskId : null;
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const handledResultTaskIdRef = React.useRef<string | null>(null);
    const confirmMove = options.confirm;
    const optionsRef = React.useRef(options);
    optionsRef.current = options;

    // Capture the initiating operation's approval target and presenters. They remain callable
    // after the leaf unmounts; reopening only adopts the coordinator's run, never adds a responder.
    const launch = React.useCallback(async (spec: SystemTaskSpec, promptOptions = optionsRef.current): Promise<string> => {
        const expectedRelayUrl = promptOptions.authRequestApproval?.expectedRelayUrl;
        const expectedAccountId = promptOptions.authRequestApproval?.expectedAccountId;
        const approvalServerId = promptOptions.authRequestApproval?.serverId;
        return await desktopSetupCoordinator.launchSetupTask({
            runner,
            spec,
            onEvent: (event) => {
                if (runner.getSnapshot(event.taskId)?.result) return;
                const consent = readSetupServiceConsentPrompt(event);
                if (consent) {
                    const present = promptOptions.onServiceConsentRequired;
                    if (!present) {
                        void runner.respond(event.taskId, { approved: false, reason: 'consent_unavailable' });
                        return;
                    }
                    void present(consent).then(
                        (approved) => runner.respond(event.taskId, { approved: approved === true }),
                        () => runner.respond(event.taskId, { approved: false, reason: 'consent_failed' }),
                    );
                    return;
                }
                const cliChoice = readSetupCliChoicePrompt(event);
                if (cliChoice) {
                    void (promptOptions.onCliChoiceRequired ?? presentCliChoiceDefault)(cliChoice).then(
                        (choice) => runner.respond(event.taskId, { choice }),
                        () => runner.respond(event.taskId, { choice: null }),
                    );
                    return;
                }
                const accountMove = readSetupAccountConsentRequest(event);
                if (accountMove) {
                    void (promptOptions.onAccountConsentRequired ?? presentAccountConsent)(accountMove).then(
                        (approved) => runner.respond(event.taskId, { approved: approved === true }),
                        () => runner.respond(event.taskId, { approved: false, reason: 'consent_failed' }),
                    );
                    return;
                }
                const prompt = readSetupPairingPrompt(event);
                if (!prompt) {
                    return;
                }
                // No relay or no account means nothing to bind the approval to; refuse by name
                // rather than approve a pairing this run cannot vouch for.
                if (!expectedRelayUrl || !expectedAccountId) {
                    void runner.respond(event.taskId, { approved: false, reason: 'approval_unavailable' });
                    return;
                }
                const confirmUnmanagedCli = promptOptions.onUnmanagedCliConsentRequired;
                void approveSetupPairingForTarget({
                    prompt,
                    activeTaskId: event.taskId,
                    target: {
                        expectedRelayUrl,
                        expectedAccountId,
                        ...(approvalServerId ? { serverId: approvalServerId } : {}),
                    },
                    ...(confirmUnmanagedCli ? { confirmUnmanagedCli } : {}),
                    respond: (answer) => runner.respond(event.taskId, answer),
                });
            },
        });
    }, [runner]);

    const start = React.useCallback(async (startOptions: ThisComputerSetupStartOptions = {}): Promise<string | null> => {
        const promptOptions = optionsRef.current;
        const startSetup = startOptions.reconcile ? desktopSetupCoordinator.reconcile : desktopSetupCoordinator.startSetup;
        const outcome = await startSetup({
            start: (spec) => launch(spec, promptOptions),
            ...(confirmMove ? { confirm: confirmMove } : {}),
            ...(startOptions.reconsiderCli ? { reconsiderCli: true } : {}),
        });
        return outcome?.taskId ?? null;
    }, [confirmMove, launch]);

    const cancel = React.useCallback(() => {
        if (activeTaskId) void runner.cancel(activeTaskId);
    }, [activeTaskId, runner]);

    // The success callback is read through a ref so this effect depends on the run it reports, not
    // on the caller's options object — every caller passes an inline literal, so depending on it
    // re-ran the effect on every render and left the exactly-once guarantee resting entirely on
    // the task-id guard.
    const onSucceededRef = React.useRef(options.onSucceeded);
    onSucceededRef.current = options.onSucceeded;
    React.useEffect(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return;
        }
        if (handledResultTaskIdRef.current === activeTaskSnapshot.taskId) {
            return;
        }
        handledResultTaskIdRef.current = activeTaskSnapshot.taskId;
        onSucceededRef.current?.(activeTaskSnapshot);
    }, [activeTaskSnapshot]);

    return {
        activeTaskId,
        activeTaskSpec: sharedRun?.runner === runner ? sharedRun.spec : null,
        activeTaskSnapshot,
        cancel,
        isStarting,
        launch,
        runner,
        start,
        startError,
    };
}
