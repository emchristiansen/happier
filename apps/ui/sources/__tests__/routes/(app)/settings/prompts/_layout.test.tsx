import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const useArtifactsLoaded = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
    Slot: () => React.createElement('PromptRouteSlot'),
}));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/sync/domains/state/storage', () => ({ useArtifactsLoaded }));

describe('PromptsLayoutRoute', () => {
    beforeEach(() => useArtifactsLoaded.mockReset());

    it('keeps every prompt route unmounted until artifact heads are materialized', async () => {
        useArtifactsLoaded.mockReturnValue(false);
        const { default: PromptsLayoutRoute } = await import('@/app/(app)/settings/prompts/_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findByTestId('prompts.artifacts.loading')).toBeTruthy();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
    });

    it('mounts the selected prompt route after artifact heads are ready', async () => {
        useArtifactsLoaded.mockReturnValue(true);
        const { default: PromptsLayoutRoute } = await import('@/app/(app)/settings/prompts/_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1);
    });
});
