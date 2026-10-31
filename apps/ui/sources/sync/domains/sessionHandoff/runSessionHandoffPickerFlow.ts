import type { ActionExecutorContext, ActionUiPlacement } from '@happier-dev/protocol';

import { openSessionHandoffPicker } from '@/components/sessions/handoff/openSessionHandoffPicker';
import type { SessionHandoffPickerResult } from '@/components/sessions/handoff/openSessionHandoffPicker';
import { Modal } from '@/modal';
import { t } from '@/text';

import { readSessionHandoffSessionActivity } from './readSessionHandoffSessionActivity';
import { runSessionHandoffUiFlow, type RunSessionHandoffUiFlowResult } from './runSessionHandoffUiFlow';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<unknown>;

async function confirmActiveSessionHandoff(sessionId: string): Promise<boolean> {
    if (readSessionHandoffSessionActivity(sessionId)?.active !== true) {
        return true;
    }

    return await Modal.confirm(
        t('sessionHandoff.activeWarning.title'),
        t('sessionHandoff.activeWarning.message'),
        {
            cancelText: t('common.cancel'),
            confirmText: t('sessionHandoff.activeWarning.confirm'),
            destructive: true,
        },
    );
}

export async function runSessionHandoffPickerFlow(args: Readonly<{
    execute: ExecuteAction;
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    placement: ActionUiPlacement;
}>): Promise<RunSessionHandoffUiFlowResult | null> {
    let closePicker = () => {};
    let setAwaiting = (_value: boolean) => {};
    let setInlineError = (_code: string | null) => {};
    let isOpen = () => true;
    let submitting = false;
    const submit = async (selection: SessionHandoffPickerResult): Promise<RunSessionHandoffUiFlowResult | null> => {
        if (submitting || !isOpen()) return null;
        submitting = true;
        let missingState = false;
        setAwaiting(true);
        setInlineError(null);
        try {
            if (!await confirmActiveSessionHandoff(args.sessionId)) return { ok: false, handled: true };
            return await runSessionHandoffUiFlow({
                execute: args.execute,
                sessionId: args.sessionId,
                targetMachineId: selection.targetMachineId,
                ...(selection.targetPath ? { targetPath: selection.targetPath } : {}),
                targetSessionStorageMode: selection.targetSessionStorageMode,
                ...(selection.stateTransfer ? { stateTransfer: selection.stateTransfer } : {}),
                onExistingStateUnavailable: () => { missingState = true; setInlineError('existing_session_state_unavailable'); },
                workspaceTransfer: selection.workspaceTransfer,
                context: {
                    defaultSessionId: args.sessionId,
                    serverId: args.serverId,
                    surface: 'ui_button',
                    placement: args.placement,
                },
            });
        } finally {
            submitting = false;
            setAwaiting(false);
            if (!missingState) closePicker();
        }
    };
    const selection = await openSessionHandoffPicker({
        sessionId: args.sessionId,
        sourceMachineId: args.sourceMachineId ?? null,
        serverId: args.serverId,
        retainOnSubmit: true,
        onRetained: (close, setPending, open, setError) => { closePicker = close; setAwaiting = setPending; isOpen = open; setInlineError = setError; },
        onSubmitAgain: (next) => { void submit(next); },
    });
    return selection ? await submit(selection) : null;
}
