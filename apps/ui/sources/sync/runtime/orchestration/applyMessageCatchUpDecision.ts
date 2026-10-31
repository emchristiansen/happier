import type { MessageCatchUpDecision } from '@/sync/runtime/orchestration/messageCatchUpPolicy';

export async function applyMessageCatchUpDecision(params: Readonly<{
    decision: MessageCatchUpDecision;
    afterSeq: number;
    onIncrementalExhausted: () => 'tail_reset_latest_page' | 'defer_forward_loading';
    fetchNewerPage: (afterSeq: number) => Promise<{ messagesCount: number; nextAfterSeq: number | null }>;
    fetchSnapshotLatestPage: () => Promise<void>;
    markLoaded: () => void;
    setDeferredForwardLoading: (deferred: boolean) => void;
}>): Promise<void> {
    if (params.decision.kind === 'do_nothing') {
        return;
    }

    if (params.decision.kind === 'defer_forward_loading') {
        params.setDeferredForwardLoading(true);
        return;
    }

    params.setDeferredForwardLoading(false);
    try {
        if (params.decision.kind === 'tail_reset_latest_page') {
            // Merge the latest page into retained history. A full reset is reserved
            // for proven source discontinuity, handled by its own callers.
            await params.fetchSnapshotLatestPage();
            params.markLoaded();
            return;
        }

        let cursor = Math.max(0, Math.trunc(params.afterSeq));
        let remainingPages = Math.max(1, Math.trunc(params.decision.maxPages));
        while (remainingPages > 0) {
            remainingPages -= 1;
            const page = await params.fetchNewerPage(cursor);
            if (page.messagesCount <= 0 || page.nextAfterSeq === null) {
                params.markLoaded();
                return;
            }
            cursor = page.nextAfterSeq;
        }

        if (params.onIncrementalExhausted() === 'tail_reset_latest_page') {
            await params.fetchSnapshotLatestPage();
            params.markLoaded();
            return;
        }

        params.setDeferredForwardLoading(true);
    } catch (error) {
        // A failed read did not satisfy catch-up demand. Keep it retryable even
        // when the session-shell hint has not advanced beyond the cached rows.
        params.setDeferredForwardLoading(true);
        throw error;
    }
}
