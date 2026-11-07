import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createTranscriptLoadingDomain, type TranscriptLoadingDomain } from './transcriptLoading';

function createHarness() {
    const store = createStore<TranscriptLoadingDomain>((set, get) => createTranscriptLoadingDomain({ set, get }));
    return { get: store.getState, subscribe: store.subscribe };
}

describe('transcriptLoading domain', () => {
    it('keeps one stable boundary projection for equivalent sequence and identity updates', () => {
        const { get, subscribe } = createHarness();
        let notifications = 0;
        subscribe(() => { notifications += 1; });
        get().setSessionTailContiguousBoundary('s1', { kind: 'seq', seq: 5 });
        get().setSessionTailContiguousBoundary('s1', { kind: 'seq', seq: 5 });
        expect(get().getSessionTailContiguousFloorSeq('s1')).toBe(5);
        get().setSessionTailContiguousBoundary('s1', { kind: 'messageIds', messageIds: ['tail'] });
        const boundary = get().getSessionTailContiguousBoundary('s1');
        get().setSessionTailContiguousBoundary('s1', { kind: 'messageIds', messageIds: ['tail'] });
        expect(get().getSessionTailContiguousBoundary('s1')).toBe(boundary);
        expect(get().getSessionTailContiguousFloorSeq('s1')).toBeNull();
        expect(get().getSessionTailContiguousBoundary('s2')).toBeNull();
        get().setSessionTailContiguousBoundary('s1', null);
        get().setSessionTailContiguousBoundary('s1', null);
        expect(notifications).toBe(3);
        expect(get().sessionTailContiguousBoundary).toEqual({});
    });

    it('fails closed: unknown session is not catching up', () => {
        const { get } = createHarness();
        expect(get().isSessionCatchingUpNewer('unknown-session')).toBe(false);
        expect(get().isSessionCatchingUpNewer('')).toBe(false);
    });

    it('flips true while a catch-up is in flight and false once settled', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('ref-counts overlapping catch-ups so the signal only settles when all finish', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);

        // First flow settles, but a second overlapping flow is still running.
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);

        // Last flow settles -> signal clears.
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('keeps per-session counts isolated', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        expect(get().isSessionCatchingUpNewer('s2')).toBe(false);
    });

    it('never drops below zero on an unbalanced end (fail-closed, no negative counts)', () => {
        const { get } = createHarness();
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('prunes settled sessions from the in-flight map (no unbounded growth)', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        get().endSessionCatchUpNewer('s1');
        expect(Object.keys(get().sessionCatchUpNewerInFlight)).not.toContain('s1');
    });
});
