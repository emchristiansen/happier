import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { Modal } from '@/modal';

import { SessionHandoffPickerModalEntry } from './SessionHandoffPickerModalEntry';
import type { SessionHandoffPickerModalProps } from './SessionHandoffPickerModal';

export type SessionHandoffPickerResult = Readonly<{
    targetMachineId: string;
    targetPath?: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    stateTransfer?: 'transfer' | 'existing';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export async function openSessionHandoffPicker(params: Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    retainOnSubmit?: boolean;
    onRetained?: (close: () => void, setAwaiting: (value: boolean) => void, isOpen: () => boolean, setInlineError: (code: string | null) => void) => void;
    onSubmitAgain?: (selection: SessionHandoffPickerResult) => void;
}>): Promise<SessionHandoffPickerResult | null> {
    return await new Promise<SessionHandoffPickerResult | null>((resolve) => {
        let settled = false;
        let modalId = '';
        let hideAfterShow = false;
        let closed = false;
        let awaitingAdmission = false;
        const close = () => {
            if (closed) return;
            closed = true;
            if (modalId) Modal.hide(modalId);
            else hideAfterShow = true;
        };
        const resolveOnce = (value: SessionHandoffPickerResult | null) => {
            if (closed) return;
            if (awaitingAdmission) { if (value === null) close(); return; }
            if (settled) {
                if (value && params.retainOnSubmit) params.onSubmitAgain?.(value);
                else if (value === null) close();
                return;
            }
            settled = true;
            resolve(value);
            if (!params.retainOnSubmit || value === null) close();
        };

        modalId = Modal.show({
            component: SessionHandoffPickerModalEntry,
            props: {
                sessionId: params.sessionId,
                sourceMachineId: params.sourceMachineId ?? null,
                serverId: params.serverId,
                onResolve: resolveOnce,
            },
            onRequestClose: () => resolveOnce(null),
            closeOnBackdrop: true,
        });
        if (params.retainOnSubmit && !closed) params.onRetained?.(close, (awaiting) => {
            if (closed || awaitingAdmission === awaiting) return;
            awaitingAdmission = awaiting;
            Modal.update<SessionHandoffPickerModalProps>(modalId, { awaitingAdmission: awaiting });
        }, () => !closed, (inlineErrorCode) => {
            if (!closed) Modal.update<SessionHandoffPickerModalProps>(modalId, { inlineErrorCode });
        });
        if (hideAfterShow) {
            Modal.hide(modalId);
        }
    });
}
