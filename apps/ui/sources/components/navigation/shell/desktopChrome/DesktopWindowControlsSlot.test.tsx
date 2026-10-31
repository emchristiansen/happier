import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
});

describe('DesktopWindowControlsSlot', () => {
    it('does not attach drag handlers when dragging is disabled', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const screen = await renderScreen(<DesktopWindowControlsSlot />);
        const dragRegion = screen.findByTestId('desktop-window-drag-region');

        expect(dragRegion?.props.onPressIn).toBeUndefined();
        expect(dragRegion?.props.onMouseDown).toBeUndefined();
    });
});
