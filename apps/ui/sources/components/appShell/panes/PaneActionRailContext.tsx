import * as React from 'react';
import { Platform } from 'react-native';

// The desktop rail has 36px controls with 4px of breathing room on either side.
// Native tablets retain their platform's full touch target without overlapping hits.
export const PANE_ACTION_RAIL_WIDTH = Platform.OS === 'web' ? 44 : Platform.OS === 'android' ? 56 : 52;

export const PaneActionRailContext = React.createContext<Readonly<{
    visible: boolean;
    contentWidthPx: number;
    rightPaneHiddenByDetails?: boolean;
}> | null>(null);

export function usePaneActionRail(): boolean {
    return React.useContext(PaneActionRailContext)?.visible ?? false;
}

export function usePaneContentWidth(): number | undefined {
    return React.useContext(PaneActionRailContext)?.contentWidthPx;
}

export function usePaneActionRailRightPaneHiddenByDetails(): boolean {
    return React.useContext(PaneActionRailContext)?.rightPaneHiddenByDetails ?? false;
}
