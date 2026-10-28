import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { usePaneActionRailRightPaneHiddenByDetails } from './PaneActionRailContext';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

installAppPaneScopeHostCommonModuleMocks({ getDimensions: () => ({ width: 1400, height: 900 }) });

// Install boundary mocks before loading owners that capture storage imports.
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { useAppPaneScope } = await import('./hooks/useAppPaneScope');

const scopeId = 'session:rail';
let pane: ReturnType<typeof useAppPaneScope>;
let mainMounts = 0;
let rightHiddenByDetails = false;

function Rail() {
    rightHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    return <View testID="rail-content" />;
}

function Main() {
    React.useEffect(() => { mainMounts += 1; }, []);
    return <View testID="main-content" />;
}

function Harness() {
    const { registerDriver } = useAppPaneContext();
    pane = useAppPaneScope(scopeId);
    React.useEffect(() => registerDriver({
        scopeId,
        renderActionRail: () => <Rail />,
        renderRightPane: () => <View testID="right-content" />,
        renderDetailsPane: () => <View testID="details-content" />,
    }), [registerDriver]);
    return <AppPaneScopeHost scopeId={scopeId} main={<Main />} />;
}

describe('AppPaneScopeHost action rail', () => {
    it.each([{ width: 1400, hidden: false }, { width: 640, hidden: true }])('reports whether opening the sidebar requires dismissing Review at $width px', async ({ width, hidden }) => {
        const screen = await renderScreen(<AppPaneProvider><Harness /></AppPaneProvider>);
        const host = screen.tree.root.findAllByType(View).find((node) => typeof node.props.onLayout === 'function');
        await act(async () => {
            host!.props.onLayout({ nativeEvent: { layout: { width, height: 900 } } });
            pane.openDetailsTab({ key: 'review', kind: 'scmReview', title: 'Review', resource: { kind: 'scmReview', scope: 'working' } });
        });
        expect(rightHiddenByDetails).toBe(hidden);
        await act(async () => { pane.openRight({ tabId: 'files' }); });
        expect(rightHiddenByDetails).toBe(hidden);
    });

    it('keeps navigation available with both panes closed and preserves the main tree through toggles', async () => {
        mainMounts = 0;
        const screen = await renderScreen(<AppPaneProvider><Harness /></AppPaneProvider>);
        expect(screen.findByTestId('rail-content')).not.toBeNull();
        expect(screen.findByTestId('right-content')).toBeNull();
        await act(async () => { pane.openRight({ tabId: 'files' }); });
        expect(screen.findByTestId('right-content')).not.toBeNull();
        await act(async () => { pane.closeRight(); });
        expect(screen.findByTestId('rail-content')).not.toBeNull();
        expect(mainMounts).toBe(1);
    });

    it('reserves the rail width before deciding whether both panes fit', async () => {
        const screen = await renderScreen(<AppPaneProvider><Harness /></AppPaneProvider>);
        await act(async () => {
            pane.openRight({ tabId: 'files' });
            pane.openDetailsTab({ key: 'review', kind: 'scmReview', title: 'Review', resource: { kind: 'scmReview', scope: 'working' } });
        });
        const host = screen.tree.root.findAllByType(View).find((node) => typeof node.props.onLayout === 'function');
        expect(host).toBeDefined();
        await act(async () => { host!.props.onLayout({ nativeEvent: { layout: { width: 930, height: 900 } } }); });
        expect(screen.findByTestId('multi-pane-details-docked')).toBeNull();
        expect(screen.findByTestId('multi-pane-details-overlay')).not.toBeNull();
        expect(screen.findByTestId('rail-content')).not.toBeNull();
    });
});
