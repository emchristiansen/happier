import * as React from 'react';

import { usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import { closeEmbeddedTerminalOutsideDockLocation, openEmbeddedTerminalInDockLocation, SESSION_DETAILS_TERMINAL_TAB_KEY } from './embeddedTerminalDocking';
import { useSessionTerminalAvailability } from './useSessionTerminalAvailability';
import { readSessionTerminalMode, setSessionTerminalMode } from './sessionTerminalMode';

/** Shared workspace-shell action; availability owns docking and openTarget owns layout routing. */
export function useSessionTerminalAction(params: Readonly<{
    sessionId: string;
    scopeId: string;
    serverId?: string | null;
}>): Readonly<{ available: boolean; active: boolean; onPress: () => void }> {
    const pane = useAppPaneScope(params.scopeId);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const { terminalEnabled, dockLocation } = useSessionTerminalAvailability({
        sessionId: params.sessionId,
        serverId: params.serverId ?? null,
    });
    const openTarget = useOpenSessionTarget({
        sessionId: params.sessionId,
        scopeId: params.scopeId,
        ...(params.serverId ? { serverId: params.serverId } : null),
    });

    const scopeState = pane.scopeState;
    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const detailsTerminalActive =
        Boolean(scopeState?.details.isOpen)
        && scopeState?.details.activeTabKey === SESSION_DETAILS_TERMINAL_TAB_KEY;

    const onPress = React.useCallback(() => {
        if (!terminalEnabled) return;
        const wasAttachedTerminal = readSessionTerminalMode(params.sessionId) === 'session_attach';
        setSessionTerminalMode(params.sessionId, 'workspace_shell');

        if (dockLocation === 'bottom') {
            if (bottomTerminalActive && !wasAttachedTerminal) {
                pane.closeBottom();
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'bottom' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'bottom' });
            return;
        }

        if (dockLocation === 'details') {
            if (detailsTerminalActive && !wasAttachedTerminal) {
                pane.closeDetailsTab(SESSION_DETAILS_TERMINAL_TAB_KEY);
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'details' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'details' });
            return;
        }

        // sidebar
        if (rightTerminalActive && !wasAttachedTerminal && !rightPaneHiddenByDetails) {
            pane.closeRight();
            return;
        }
        if (rightPaneHiddenByDetails) pane.closeDetails();
        closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'sidebar' });
        // The right pane where this layout has one, `/session/<id>/terminal` where it does not.
        openTarget({ kind: 'terminal' });
    }, [
        bottomTerminalActive,
        detailsTerminalActive,
        dockLocation,
        openTarget,
        pane,
        rightTerminalActive,
        rightPaneHiddenByDetails,
        terminalEnabled,
        params.sessionId,
    ]);

    const active = dockLocation === 'bottom'
        ? bottomTerminalActive
        : dockLocation === 'details'
            ? detailsTerminalActive
            : rightTerminalActive && !rightPaneHiddenByDetails;

    return { available: terminalEnabled, active: terminalEnabled && active, onPress };
}
