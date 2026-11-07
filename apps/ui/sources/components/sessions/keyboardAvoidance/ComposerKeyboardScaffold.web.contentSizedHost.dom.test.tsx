/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useComposerKeyboardLayout } from './ComposerKeyboardContext';

const viewport = vi.hoisted(() => ({ height: 900 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1440, height: viewport.height, scale: 1, fontScale: 1 }),
    });
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const published = vi.hoisted(() => ({ availablePanelHeight: undefined as number | undefined }));

function AvailablePanelHeightProbe(): null {
    const layout = useComposerKeyboardLayout();
    React.useEffect(() => layout?.subscribeAvailablePanelHeight?.((height) => {
        published.availablePanelHeight = height;
    }), [layout]);
    return null;
}

type HostedScaffold = Readonly<{ hostElement: HTMLElement; scaffoldElement: HTMLElement }>;

// jsdom has no layout engine, so the host's rendered height is supplied the way a browser would
// report it; its CSS (max-height, overflow) stays real and is read through getComputedStyle.
function createHostedScaffold(host: Readonly<{ maxHeight?: string; overflowY: string; renderedHeight: number }>): HostedScaffold {
    const hostElement = document.createElement('div');
    hostElement.style.overflowY = host.overflowY;
    if (host.maxHeight) hostElement.style.maxHeight = host.maxHeight;
    Object.defineProperty(hostElement, 'offsetHeight', { configurable: true, value: host.renderedHeight });
    // Mirrors the live desktop topology: the route modal wraps the screen in its own scrolling
    // body, which is content-sized and carries no max-height of its own.
    const modalBody = document.createElement('div');
    modalBody.style.overflowY = 'auto';
    const screenContainer = document.createElement('div');
    screenContainer.style.overflow = 'hidden';
    const scaffoldElement = document.createElement('div');
    hostElement.append(modalBody);
    modalBody.append(screenContainer);
    screenContainer.append(scaffoldElement);
    document.body.append(hostElement);
    return { hostElement, scaffoldElement };
}

async function renderScaffoldAndLayout(params: Readonly<{ height: number; target?: HTMLElement }>): Promise<() => void> {
    const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
    const renderElement = () => (
        <ComposerKeyboardScaffold
            mode="newSession"
            testID="scaffold"
            composer={<AvailablePanelHeightProbe />}
        >
            <React.Fragment>content</React.Fragment>
        </ComposerKeyboardScaffold>
    );
    const screen = await renderScreen(renderElement());
    const scaffold = screen.tree.root.findAll((node) => node.props.testID === 'scaffold' && typeof node.props.onLayout === 'function')[0];
    if (!scaffold) throw new Error('Expected the scaffold root to accept layout events');
    act(() => {
        scaffold.props.onLayout({ nativeEvent: { layout: { height: params.height }, target: params.target } });
    });
    return () => {
        act(() => {
            screen.tree.update(renderElement());
        });
    };
}

describe('ComposerKeyboardScaffold web inside a content-sized host', () => {
    beforeEach(() => {
        standardCleanup();
        document.body.replaceChildren();
        published.availablePanelHeight = undefined;
        viewport.height = 900;
    });

    it('offers the composer the room the scrolling host can still grow into', async () => {
        // Desktop /new: the route modal sizes to its content up to a viewport cap and scrolls beyond it.
        const { scaffoldElement } = createHostedScaffold({ maxHeight: '804px', overflowY: 'auto', renderedHeight: 300 });

        await renderScaffoldAndLayout({ height: 236, target: scaffoldElement });

        expect(published.availablePanelHeight).toBe(236 + (804 - 300));
    });

    it('re-reads the host room when the window resizes without resizing the scaffold', async () => {
        const { hostElement, scaffoldElement } = createHostedScaffold({ maxHeight: '804px', overflowY: 'auto', renderedHeight: 300 });
        const rerender = await renderScaffoldAndLayout({ height: 236, target: scaffoldElement });

        // The host's viewport-derived cap shrinks with the window.
        hostElement.style.maxHeight = '604px';
        viewport.height = 700;
        rerender();

        expect(published.availablePanelHeight).toBe(236 + (604 - 300));
    });

    it('keeps its own height as the cap when no scrolling ancestor bounds it', async () => {
        const { scaffoldElement } = createHostedScaffold({ overflowY: 'auto', renderedHeight: 300 });

        await renderScaffoldAndLayout({ height: 236, target: scaffoldElement });

        expect(published.availablePanelHeight).toBe(236);
    });
});
