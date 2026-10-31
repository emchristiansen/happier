import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'android' },
            Pressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Pressable', props, children),
        });
    },
});

function flattenStyle(style: unknown): Record<string, unknown> {
    return (Array.isArray(style) ? style : [style])
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
        .reduce<Record<string, unknown>>((merged, value) => ({ ...merged, ...value }), {});
}

describe('SegmentedTabBar Android targets', () => {
    it('uses non-overlapping 48dp tab boxes', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar
                tabs={[{ id: 'git', label: 'Git' }, { id: 'files', label: 'Files' }]}
                activeTabId="git"
                onSelectTab={() => {}}
                testIDPrefix="seg"
            />,
        );
        const tab = screen.findByTestId('seg:git');
        if (!tab) throw new Error('Expected Git tab');
        expect(flattenStyle(tab.props.style).minHeight).toBe(48);
        expect(tab.props.hitSlop).toBeUndefined();
    });
});
