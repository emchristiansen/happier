import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

// React Native is the platform boundary. Store, highlighting policy and code rows remain real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

describe('Happier diff viewers horizontal overflow', () => {
    it.each(['text', 'unified'] as const)(
        'scrolls no-wrap %s diff rows horizontally on Android while retaining selection of wrapped changed words',
        async (mode) => {
            const { HappierTextDiffViewer } = await import('./HappierTextDiffViewer');
            const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

            for (const wrapLines of [false, true]) {
                const screen = await renderScreen(mode === 'text' ? (
                    <HappierTextDiffViewer
                        mode="text"
                        oldText="const before = 1;"
                        newText="const after = 1;"
                        virtualized={false}
                        wrapLines={wrapLines}
                    />
                ) : (
                    <HappierUnifiedDiffViewer
                        mode="unified"
                        unifiedDiff={'@@ -1 +1 @@\n-const before = 1;\n+const after = 1;\n'}
                        virtualized={false}
                        wrapLines={wrapLines}
                    />
                ));

                expect(screen.tree.root.findAll((node) => typeof node.type === 'string' && String(node.type) === 'GestureHandlerScrollView')).toHaveLength(0);
                const scrollViews = screen.tree.root.findAll((node) => typeof node.type === 'string' && String(node.type) === 'ScrollView');
                expect(scrollViews).toHaveLength(wrapLines ? 0 : 1);
                if (!wrapLines) {
                    expect(scrollViews[0]!.props.horizontal).toBe(true);
                    expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
                }

                for (const text of ['before', 'after']) {
                    const textNodes = screen.tree.root.findAll((node) => typeof node.type === 'string' && String(node.type) === 'Text' && node.props.children === text);
                    expect(textNodes.length).toBeGreaterThan(0);
                    expect(textNodes.map((node) => node.props.selectable)).toEqual(textNodes.map(() => wrapLines));
                }
            }
        },
    );
});
