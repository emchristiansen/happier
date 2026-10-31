import * as React from 'react';
import { View } from 'react-native';

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
        { platformOS: 'ios' },
        {
            ScrollView: 'ScrollView',
            View: 'View',
        },
    );
});

vi.mock('./ScrollEdgeFades', async () => ({
    ScrollEdgeFades: (props: Record<string, unknown>) => React.createElement('ScrollEdgeFades', props),
}));

vi.mock('./ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

describe('HorizontalScrollableRow', () => {
    it('applies row layout to the native scroll content container', async () => {
        const { HorizontalScrollableRow } = await import('./HorizontalScrollableRow');
        const contentStyle = {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            gap: 8,
            paddingHorizontal: 12,
        };

        const screen = await renderScreen(
            <HorizontalScrollableRow
                testID="horizontal-row"
                contentTestID="horizontal-row-content"
                fadeColor="#fff"
                indicatorColor="#000"
                contentStyle={contentStyle}
            >
                <View testID="first-option" />
                <View testID="last-option" />
            </HorizontalScrollableRow>,
        );

        const scrollView = screen.findByTestId('horizontal-row');
        expect(scrollView?.props.contentContainerStyle).toBe(contentStyle);
        expect(screen.findByTestId('first-option')?.parent).toBe(scrollView);
        expect(screen.findByTestId('last-option')?.parent).toBe(scrollView);
    });

    it('ends at the consumer content edge without an extra trailing gutter', async () => {
        const { HorizontalScrollableRow } = await import('./HorizontalScrollableRow');
        const screen = await renderScreen(
            <HorizontalScrollableRow
                testID="horizontal-row"
                fadeColor="#fff"
                indicatorColor="#000"
                contentStyle={{ paddingHorizontal: 12 }}
            >
                <View testID="last-option" />
            </HorizontalScrollableRow>,
        );

        const scrollView = screen.findByTestId('horizontal-row');
        expect(screen.findByTestId('horizontal-row-end-gutter')).toBeNull();

        act(() => {
            scrollView?.props.onLayout({ nativeEvent: { layout: { width: 220, height: 44 } } });
            scrollView?.props.onContentSizeChange(480, 44);
            scrollView?.props.onScroll({
                nativeEvent: {
                    contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
                    contentOffset: { x: 236, y: 0 },
                    layoutMeasurement: { width: 220, height: 44 },
                    contentSize: { width: 480, height: 44 },
                    zoomScale: 1,
                },
            });
        });
        expect(screen.findByType('ScrollEdgeFades' as any)?.props.edges.right).toBe(true);

        act(() => {
            scrollView?.props.onScroll({
                nativeEvent: {
                    contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
                    contentOffset: { x: 260, y: 0 },
                    layoutMeasurement: { width: 220, height: 44 },
                    contentSize: { width: 480, height: 44 },
                    zoomScale: 1,
                },
            });
        });
        expect(screen.findByType('ScrollEdgeFades' as any)?.props.edges.right).toBe(false);
    });
});
