import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { findNearestHostParent, flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
});

const setStringAsyncSpy = vi.fn<(text: string) => Promise<boolean>>(async (_text) => true);

// expo-clipboard is a native module boundary; the spy records what reaches the system clipboard.
vi.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => setStringAsyncSpy(text),
}));

function mockPlatform(os: 'android' | 'ios' | 'web') {
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: os,
            },
        });
    });
}

describe('MarkdownView (tables)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('renders tables inside the platform ScrollView on Android so horizontal drags share native nested scrolling with the transcript list', async () => {
        mockPlatform('android');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| A | B | C |',
            '|---|---|---|',
            '| 1 | 2 | 3 |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        expect(screen.findAllByType('GestureHandlerScrollView' as any)).toHaveLength(0);
        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
    }, 60_000);

    it('uses a visible horizontal scrollbar on web and does not clip the scroll shell', async () => {
        mockPlatform('web');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Name | Reliability | Notes |',
            '|---|---|---|',
            '| Claude | High | Long cell content that exceeds the viewport width |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.showsHorizontalScrollIndicator).toBe(true);

        const scrollShell = findNearestHostParent(scrollViews[0]);
        expect(scrollShell).toBeTruthy();
        const shellStyle = flattenTestStyle(scrollShell?.props?.style);
        expect(shellStyle.alignSelf).toBe('flex-start');
        expect(shellStyle.maxWidth).toBe('100%');
    }, 60_000);

    it('keeps table text selectable on iOS but not inside the Android horizontal scroller, where selection fights the scroll gesture', async () => {
        const markdown = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        for (const [os, expected] of [['ios', true], ['android', false]] as const) {
            vi.resetModules();
            mockPlatform(os);
            const { MarkdownView } = await import('./MarkdownView');

            const screen = await renderScreen(<MarkdownView markdown={markdown} />);

            const findTextNode = (text: string) =>
                screen.findAllByType('Text' as any).find((n) => n.props?.children === text)!;

            expect(findTextNode('A').props.selectable, os).toBe(expected);
            expect(findTextNode('1').props.selectable, os).toBe(expected);
        }
    }, 60_000);

    it('copies the table as markdown from its copy button, preserving alignment, escaped pipes and the rendered column count', async () => {
        mockPlatform('android');
        setStringAsyncSpy.mockClear();
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Left | Center | Right | Plain |',
            '| :--- | :---: | ---: | --- |',
            '| **a** | b \\| c | d |  |',
            '| short |',
            '| 1 | 2 | 3 | 4 | ignored |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        await pressTestInstanceAsync(screen.findByTestId('markdown-table-copy'), 'table copy');

        expect(setStringAsyncSpy).toHaveBeenCalledWith([
            '| Left | Center | Right | Plain |',
            '| :--- | :---: | ---: | --- |',
            '| **a** | b \\| c | d |  |',
            '| short |  |  |  |',
            '| 1 | 2 | 3 | 4 |',
        ].join('\n'));
    }, 60_000);

    it('renders math table cells through the enriched renderer without losing horizontal scrolling', async () => {
        mockPlatform('android');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Formula | Existing | Plain |',
            '|---|---|---|',
            '| \\(x_i\\) | $y_i$ | value |',
        ].join('\n');

        const screen = await renderScreen(
            <MarkdownView markdown={markdown} selectable profile="transcript" agentTexMath />,
        );

        expect(screen.findAllByType('ScrollView' as any)).toHaveLength(1);
        expect(screen.findAllByType('EnrichedMarkdownText').map((node) => node.props.selectable)).toEqual([false, false]);
        expect(screen.findAllByType('EnrichedMarkdownText').map((node) => node.props.markdown)).toEqual([
            '\\(x_i\\)',
            '$y_i$',
        ]);
        expect(screen.findAllByType('EnrichedMarkdownText').map((node) => node.props.md4cFlags)).toEqual([
            { latexMath: true, texMathBackslashDelimiters: true },
            { latexMath: true, texMathBackslashDelimiters: true },
        ]);
        expect(screen.findAllByType('Text' as any).some((node) => node.props.children === 'value')).toBe(true);
    }, 60_000);

    it('applies GitHub table column alignment to header and body cells', async () => {
        mockPlatform('web');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Left | Center | Right |',
            '| :--- | :---: | ---: |',
            '| Alpha | Bravo | Charlie |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const findTextNode = (text: string) =>
            screen.findAllByType('Text' as any).find((n) => n.props?.children === text)!;

        expect(flattenTestStyle(findTextNode('Alpha').props.style).textAlign).toBe('left');
        expect(flattenTestStyle(findTextNode('Bravo').props.style).textAlign).toBe('center');
        expect(flattenTestStyle(findTextNode('Charlie').props.style).textAlign).toBe('right');

        const rightCell = findNearestHostParent(findTextNode('Charlie'), 'View');
        expect(flattenTestStyle(rightCell?.props?.style).alignItems).toBe('flex-end');
    }, 60_000);
});
