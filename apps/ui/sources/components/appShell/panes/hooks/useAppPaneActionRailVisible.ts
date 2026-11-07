import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { useAppPaneContext } from '../AppPaneProvider';

/** Shared by the pane host and chrome rendered outside the host's subtree. */
export function useAppPaneActionRailVisible(scopeId: string): boolean {
    const pane = useAppPaneContext();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    return multiPaneEnabled && deviceType !== 'phone' && Boolean(pane.getDriver(scopeId)?.renderActionRail);
}
