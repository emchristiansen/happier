import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

vi.mock('@/sync/sync', () => ({
    sync: { getSyncTuning: () => ({ transcriptFlashListEstimatedItemSize: 120, transcriptBackwardPrefetchThresholdPx: 800 }) },
}));

describe('sidechain visual edge content', () => {
    it.each(['ios', 'android', 'web'])('keeps context above and debug below the transcript on %s', async (os) => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const { Platform, View } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
        try {
            const screen = await renderScreen(
                <ChainTranscriptList
                    sessionId="session-1"
                    datasetKey="sidechain-1"
                    messages={[]}
                    metadata={null}
                    interaction={{ canSendMessages: false, canApprovePermissions: false }}
                    isInitialLoadInFlight={false}
                    header={<View testID="context" />}
                    footer={<View testID="debug" />}
                />,
            );
            // Legend presents chronological physical space even for newest-first native frames.
            // Observe the real adapter's physical slots, not the shell's input prop names.
            const list = screen.findByType('LegendList');
            const top = list.children[0];
            const bottom = list.children.at(-1);
            if (typeof top === 'string' || typeof bottom === 'string' || !top || !bottom) throw new Error('Missing list slots');
            expect(top.findAllByProps({ testID: 'context' })).toHaveLength(1);
            expect(bottom.findAllByProps({ testID: 'debug' })).toHaveLength(1);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
