import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationLoadResult,
    type UseTranscriptOlderPaginationInput,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { resolveMainTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

import { useTranscriptItemsEdgeSlots } from './useTranscriptRowHost';

const ACTION_ID = 'transcript-older-load-continue';

function UnderfilledTranscript(props: Readonly<{
    loadOlder: UseTranscriptOlderPaginationInput['loadOlder'];
    platformOS: 'web' | 'ios';
    showFirstPaintPlaceholder?: boolean;
}>) {
    const pagination = useTranscriptOlderPagination({
        enabled: true,
        loadOlder: props.loadOlder,
        thresholdPx: 400,
        cooldownMs: 500,
        spinnerDelayMs: 0,
        isFillDone: () => true,
        isTransactionOpen: () => false,
    });
    React.useEffect(() => {
        // Initial fill retained an older cursor, but raw-only pages did not make the
        // displayed lane scrollable. Ordinary observations must not start a replay.
        pagination.onScrollObservation({ offsetY: 0, scrollable: false, trigger: 'scroll' });
    }, [pagination.onScrollObservation]);
    const slots = useTranscriptItemsEdgeSlots({
        bottomNotice: null,
        composerInsetHeight: 0,
        controlSwitchTo: null,
        controlledByUserOverride: undefined,
        directControlFooter: undefined,
        handleComposerInsetHeightChange: () => {},
        handleNativeHotTailHeightChange: () => {},
        isLoadingOlder: false,
        mainTranscriptListShellFrame: resolveMainTranscriptListShellFrame({ platformOS: props.platformOS }),
        onRequestSwitchToRemote: undefined,
        olderPaginationIsLoadingOlder: pagination.isLoadingOlder,
        olderPaginationCanContinue: pagination.hasMore,
        onContinueOlderPagination: pagination.continueOlderLoad,
        prependRangeReservePx: 0,
        renderTranscriptItemAtIndex: () => null,
        sessionId: 'underfilled-transcript',
        shouldUseNativeHotColdSplit: false,
        shouldUseWebHotColdSplit: false,
        showCatchUpOverlay: false,
        showFirstPaintPlaceholder: props.showFirstPaintPlaceholder === true,
        transcriptHotColdSegments: {
            active: false, coldCount: 0, coldItems: [], hotCount: 0, hotItems: [],
            hotItemsCanonical: [], nativeEdgeSlotItems: [], splitIndex: 0, webFooterItems: [],
        },
        transcriptOlderLoadSpinnerDelayMs: 0,
    });
    return slots.olderLoadOverlay;
}

describe('underfilled transcript older continuation', () => {
    const originalPlatform = Platform.OS;
    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        vi.useRealTimers();
        standardCleanup();
    });

    it.each(['web', 'ios'] as const)('lets the reader continue a non-scrollable %s transcript without automatic replay', async (platformOS) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platformOS });
        vi.useFakeTimers();
        const firstPage = createDeferred<TranscriptOlderPaginationLoadResult>();
        const loadOlder = vi.fn<UseTranscriptOlderPaginationInput['loadOlder']>()
            .mockReturnValueOnce(firstPage.promise)
            .mockResolvedValueOnce({ status: 'no_more', loaded: 1, hasMore: false });
        const screen = await renderScreen(<UnderfilledTranscript loadOlder={loadOlder} platformOS={platformOS} showFirstPaintPlaceholder />);
        expect(screen.findByTestId(ACTION_ID)).toBeNull();
        expect(loadOlder).not.toHaveBeenCalled();
        await screen.update(<UnderfilledTranscript loadOlder={loadOlder} platformOS={platformOS} />);

        expect(loadOlder).not.toHaveBeenCalled();
        expect(screen.findByTestId(ACTION_ID)).not.toBeNull();
        const press = screen.findByTestId(ACTION_ID)!.props.onPress as () => void;
        await act(async () => { press(); press(); });
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('transcript-older-load-progress-overlay')).not.toBeNull();
        expect(screen.findByTestId(ACTION_ID)).toBeNull();

        await act(async () => { firstPage.resolve({ status: 'loaded', loaded: 8, hasMore: true }); });
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId(ACTION_ID)).not.toBeNull();
        await screen.pressByTestIdAsync(ACTION_ID);
        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ACTION_ID)).toBeNull();
        expect(screen.findByTestId('transcript-older-load-progress-overlay')).toBeNull();
    });
});
