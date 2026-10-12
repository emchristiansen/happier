import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

/**
 * The desktop window chrome on the setup surface. It only exists on the Tauri desktop host, so
 * these cases run against the testkit's web `react-native` mock rather than the shared node stub.
 */
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

import { SetupSurface } from './SetupSurface';
import type { SetupLocalFacts } from './setupStageModel';

const FACTS: SetupLocalFacts = { relayDisplayName: 'relay.example.test', entry: 'setup', startFailure: null };

describe('SetupSurface desktop chrome', () => {
    it('leaves window controls and titlebar dragging with the app shell it sits in (R11)', async () => {
        const screen = await renderScreen(<SetupSurface run={null} facts={FACTS} />);

        // A veil over the Home content inside the running shell: that shell keeps its one controls and drag owners.
        expect(screen.findByTestId('setup-surface:veil')).not.toBeNull();
        expect(screen.findByTestId('setup-surface-desktop-chrome')).toBeNull();
        expect(screen.findByTestId('desktop-main-content-drag-surface')).toBeNull();
    });
});
