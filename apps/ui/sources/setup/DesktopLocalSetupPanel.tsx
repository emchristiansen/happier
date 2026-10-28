import * as React from 'react';

import { DesktopSetupTaskSurface } from './DesktopSetupTaskSurface';
import { useDesktopLocalSetupPanelModel, usePresentDesktopLocalSetupPanel } from './DesktopLocalSetupRuntime';

/**
 * Keeps the panel mounted for its one departure beat after the lifecycle stops presenting it, so
 * it leaves rather than being cut. Nothing waits on it: the Home underneath is live throughout.
 */
function useDeparture(visible: boolean): Readonly<{ mounted: boolean; exiting: boolean; onExited: () => void }> {
    const [departing, setDeparting] = React.useState(false);
    const wasVisibleRef = React.useRef(visible);
    React.useEffect(() => {
        if (visible) {
            wasVisibleRef.current = true;
            setDeparting(false);
            return;
        }
        if (!wasVisibleRef.current) return;
        wasVisibleRef.current = false;
        setDeparting(true);
    }, [visible]);
    const onExited = React.useCallback(() => setDeparting(false), []);
    return { mounted: visible || departing, exiting: !visible, onExited };
}

/**
 * R11 — the Home's view of this computer's setup: the setup veil over the Home content area only
 * (the sidebar, navigation and every other route stay usable).
 * It owns no lifecycle — `DesktopLocalSetupRuntime` at the shell does — so leaving the Home never
 * pauses setup, and returning shows the same run. It renders nothing when there is nothing to say.
 */
export function DesktopLocalSetupPanel(): React.ReactElement | null {
    const model = useDesktopLocalSetupPanelModel();
    const departure = useDeparture(model?.visible === true);
    // Presence, not the departure beat: once it is leaving, the Home's own card may come back.
    usePresentDesktopLocalSetupPanel(model?.visible === true);
    if (model == null || !departure.mounted) {
        return null;
    }
    return (
        <DesktopSetupTaskSurface
            inspectionTaskId={model.inspectionTaskId}
            run={model.run}
            facts={model.facts}
            onRetry={model.retry}
            onContinueWithout={model.continueWithoutThisComputer}
            onUpdateCli={model.updateCli}
            updatingCli={model.updatingCli}
            exiting={departure.exiting}
            onExited={departure.onExited}
            testID="desktop-setup-panel"
        />
    );
}
