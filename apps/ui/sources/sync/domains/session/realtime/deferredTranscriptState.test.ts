import { describe, expect, it } from 'vitest';

import {
    acknowledgeStaleTranscriptRepair,
    clearDeferredTranscriptStateForSession,
    createDeferredTranscriptState,
    markTranscriptStale,
    readStaleTranscriptMessageIds,
    readStaleTranscriptMessageSeqs,
} from './deferredTranscriptState';

describe('deferred transcript stale repair acknowledgement', () => {
    it.each(['repair', 'reset'] as const)('retains a new same-row marker when an older repair acknowledges after %s clears its snapshot', (clearMode) => {
        const marker = { updateType: 'message-updated' as const, seq: 15, messageId: 'm15' };
        const first = markTranscriptStale(createDeferredTranscriptState(), 's1', marker);
        // Two visibility activations can start independent repairs of this snapshot.
        const expected = readStaleTranscriptMessageSeqs(first, 's1');
        const completed = clearMode === 'repair'
            ? acknowledgeStaleTranscriptRepair(first, 's1', expected)
            : clearDeferredTranscriptStateForSession(first, 's1');
        expect(readStaleTranscriptMessageIds(completed, 's1')).toEqual([]);

        const editedAgain = markTranscriptStale(completed, 's1', marker);
        const afterOldRepair = acknowledgeStaleTranscriptRepair(editedAgain, 's1', expected);

        expect(readStaleTranscriptMessageIds(afterOldRepair, 's1')).toEqual(['m15']);
        expect(afterOldRepair).toBe(editedAgain);
    });
});
