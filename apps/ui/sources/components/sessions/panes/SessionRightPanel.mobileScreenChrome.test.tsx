import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const closeRightSpy = vi.fn();
const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

let scopeState: {
    right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
} = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                    options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android,
            },
        });
    },
    storage: async () => ({
        useLocalSetting: () => 'sidebar',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => 'en',
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        closeRight: closeRightSpy,
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: () => React.createElement('FilesView'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => React.createElement('GitView'),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => React.createElement('AgentsView'),
}));

vi.mock('@/components/sessions/panes/terminal/SessionRightPanelTerminalView', () => ({
    SessionRightPanelTerminalView: () => React.createElement('TerminalView'),
}));

function findParentContaining(
    root: renderer.ReactTestInstance,
    child: renderer.ReactTestInstance,
): renderer.ReactTestInstance | null {
    return root.findAll((node) => node.children.includes(child)).at(0) ?? null;
}

const { SessionRightPanel } = await import('./SessionRightPanel');

describe('SessionRightPanel (mobile screen chrome)', () => {
    beforeEach(() => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
        };
        closeRightSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        vi.clearAllMocks();
    });

    it('omits redundant header controls when the pane has an external action rail', async () => {
        const { PaneActionRailContext } = await import('@/components/appShell/panes/PaneActionRailContext');
        const screen = await renderScreen(
            <PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000 }}>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </PaneActionRailContext.Provider>,
        );
        expect(screen.findByTestId('session-rightpanel-close')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:git')).toBeNull();
    });

    it('renders the screen close affordance as a leading back button on native', async () => {
        const screen = await renderScreen(
            <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        const closeButton = screen.findByTestId('session-rightpanel-close');
        if (!closeButton) {
            throw new Error('Expected close button to render');
        }
        expect(closeButton.props.accessibilityLabel).toBe('common.back');
        expect(findTestInstanceByTypeWithProps(closeButton, 'Icon', { name: 'caret-left' })).toBeTruthy();

        const header = findParentContaining(screen.tree.root, closeButton);
        if (!header) {
            throw new Error('Expected close button to be inside the header');
        }
        expect(header.children[0]).toBe(closeButton);
    });

    it('uses a 48dp close target on Android screens', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        Platform.OS = 'android';
        try {
            const screen = await renderScreen(
                <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
            );
            const closeButton = screen.findByTestId('session-rightpanel-close');
            if (!closeButton) throw new Error('Expected close button');
            const resolvedStyle = typeof closeButton.props.style === 'function'
                ? closeButton.props.style({ pressed: false, hovered: false })
                : closeButton.props.style;
            const flattenStyle = (value: unknown): Record<string, unknown> => Array.isArray(value)
                ? value.reduce<Record<string, unknown>>((merged, entry) => ({ ...merged, ...flattenStyle(entry) }), {})
                : Boolean(value) && typeof value === 'object' ? value as Record<string, unknown> : {};
            const style = flattenStyle(resolvedStyle);
            expect(style).toMatchObject({ width: 48, height: 48 });
        } finally {
            Platform.OS = previousPlatform;
        }
    });
});
