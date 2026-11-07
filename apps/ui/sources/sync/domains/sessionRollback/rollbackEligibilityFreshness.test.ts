import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

import { didRollbackEligibilityBecomeStale, mergeRollbackEligibility } from './rollbackEligibilityFreshness';

describe('mergeRollbackEligibility', () => {
    const known = [1, 3] as const;

    it('keeps known starts from a snapshot that does not carry eligibility, marked stale', () => {
        expect(mergeRollbackEligibility({ rollbackEligibleTurnStarts: known }, { rollbackEligibleTurnStarts: undefined }))
            .toEqual({ rollbackEligibleTurnStarts: known, rollbackEligibilityStale: true });
        expect(mergeRollbackEligibility({ rollbackEligibleTurnStarts: null }, { rollbackEligibleTurnStarts: undefined }))
            .toEqual({ rollbackEligibleTurnStarts: null, rollbackEligibilityStale: true });
    });

    it('does not invent staleness for eligibility that was never known', () => {
        expect(mergeRollbackEligibility(undefined, { rollbackEligibleTurnStarts: undefined }))
            .toEqual({ rollbackEligibleTurnStarts: undefined, rollbackEligibilityStale: undefined });
        expect(mergeRollbackEligibility({ rollbackEligibleTurnStarts: undefined }, { rollbackEligibleTurnStarts: undefined }))
            .toEqual({ rollbackEligibleTurnStarts: undefined, rollbackEligibilityStale: undefined });
    });

    it('keeps staleness through a patch that spreads the stored session', () => {
        const stored = { rollbackEligibleTurnStarts: known, rollbackEligibilityStale: true };
        expect(mergeRollbackEligibility(stored, { ...stored })).toEqual({ rollbackEligibleTurnStarts: known, rollbackEligibilityStale: true });
        // A patch cannot clear staleness by claiming freshness.
        expect(mergeRollbackEligibility(stored, { ...stored, rollbackEligibilityStale: false }).rollbackEligibilityStale).toBe(true);
    });

    it('treats newly read starts as confirmation, even when equal to the stale value', () => {
        const stored = { rollbackEligibleTurnStarts: known, rollbackEligibilityStale: true };
        expect(mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [1, 3] }))
            .toEqual({ rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityStale: undefined });
        expect(mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [] }))
            .toEqual({ rollbackEligibleTurnStarts: [], rollbackEligibilityStale: undefined });
    });

    it('ignores a staleness flag carried by new evidence', () => {
        expect(mergeRollbackEligibility(undefined, { rollbackEligibleTurnStarts: [5], rollbackEligibilityStale: true }))
            .toEqual({ rollbackEligibleTurnStarts: [5], rollbackEligibilityStale: undefined });
    });

    it('drops starts observed before the stored evidence, keeping the stored starts and status', () => {
        const revoked = { rollbackEligibleTurnStarts: [] as number[], rollbackEligibilityObservedAt: 7 };
        // A read that started (observation 5) before the revocation arrived (observation 7).
        const result = mergeRollbackEligibility(revoked, { rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityObservedAt: 5 });
        expect(result.rollbackEligibleTurnStarts).toBe(revoked.rollbackEligibleTurnStarts);
        expect(result).toEqual({ rollbackEligibleTurnStarts: [], rollbackEligibilityStale: undefined, rollbackEligibilityObservedAt: 7 });
        // The same older read cannot confirm stale starts either; they stay stale for a newer read.
        expect(mergeRollbackEligibility({ ...revoked, rollbackEligibilityStale: true }, { rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityObservedAt: 5 }))
            .toEqual({ rollbackEligibleTurnStarts: [], rollbackEligibilityStale: true, rollbackEligibilityObservedAt: 7 });
    });

    it('keeps the stored turns projection when the incoming evidence is older', () => {
        const storedProjection = { v: 1, sessionId: 's', latestTurnId: 'turn-2', updatedAt: 9, turns: [] } as unknown as NonNullable<Session['sessionTurns']>;
        const olderProjection = { v: 1, sessionId: 's', latestTurnId: 'turn-2', updatedAt: 4, turns: [] } as unknown as NonNullable<Session['sessionTurns']>;
        const stored = { rollbackEligibleTurnStarts: [] as number[], rollbackEligibilityObservedAt: 7, sessionTurns: storedProjection };
        const older = mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityObservedAt: 5, sessionTurns: olderProjection });
        expect(older.sessionTurns).toBe(storedProjection);
        expect(older.rollbackEligibleTurnStarts).toBe(stored.rollbackEligibleTurnStarts);
        // The kept projection keeps its own observation, not the older incoming one.
        const ordered = mergeRollbackEligibility(
            { ...stored, sessionTurnsObservedAt: 7 },
            { rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityObservedAt: 5, sessionTurns: olderProjection, sessionTurnsObservedAt: 5 },
        );
        expect(ordered.sessionTurns).toBe(storedProjection);
        expect(ordered.sessionTurnsObservedAt).toBe(7);
        expect(older.sessionTurnsObservedAt).toBeUndefined();
        // Newer or unordered evidence leaves the incoming projection to the caller (no key returned).
        expect('sessionTurns' in mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [1], rollbackEligibilityObservedAt: 9, sessionTurns: olderProjection })).toBe(false);
        expect('sessionTurns' in mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [1], sessionTurns: olderProjection })).toBe(false);
    });

    it('accepts starts observed later, and unordered evidence, as confirmation', () => {
        const stored = { rollbackEligibleTurnStarts: [1, 3] as number[], rollbackEligibilityStale: true, rollbackEligibilityObservedAt: 7 };
        expect(mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [3], rollbackEligibilityObservedAt: 9 }))
            .toEqual({ rollbackEligibleTurnStarts: [3], rollbackEligibilityStale: undefined, rollbackEligibilityObservedAt: 9 });
        expect(mergeRollbackEligibility(stored, { rollbackEligibleTurnStarts: [3] }))
            .toEqual({ rollbackEligibleTurnStarts: [3], rollbackEligibilityStale: undefined, rollbackEligibilityObservedAt: undefined });
        // A snapshot without eligibility keeps the stored observation with the stale starts.
        expect(mergeRollbackEligibility({ ...stored, rollbackEligibilityStale: undefined }, { rollbackEligibleTurnStarts: undefined }))
            .toEqual({ rollbackEligibleTurnStarts: [1, 3], rollbackEligibilityStale: true, rollbackEligibilityObservedAt: 7 });
    });
});

describe('didRollbackEligibilityBecomeStale', () => {
    it('is true only on the transition into staleness', () => {
        expect(didRollbackEligibilityBecomeStale({ rollbackEligibleTurnStarts: [1] }, { rollbackEligibleTurnStarts: [1], rollbackEligibilityStale: true })).toBe(true);
        expect(didRollbackEligibilityBecomeStale(
            { rollbackEligibleTurnStarts: [1], rollbackEligibilityStale: true },
            { rollbackEligibleTurnStarts: [1], rollbackEligibilityStale: true },
        )).toBe(false);
        expect(didRollbackEligibilityBecomeStale({ rollbackEligibleTurnStarts: [1], rollbackEligibilityStale: true }, { rollbackEligibleTurnStarts: [2] })).toBe(false);
        expect(didRollbackEligibilityBecomeStale(undefined, undefined)).toBe(false);
    });
});
