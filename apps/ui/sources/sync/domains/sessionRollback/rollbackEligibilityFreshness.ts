import type { Session } from '@/sync/domains/state/storageTypes';

type RollbackEligibilityFields = Pick<
    Session,
    'rollbackEligibleTurnStarts' | 'rollbackEligibilityStale' | 'rollbackEligibilityObservedAt' | 'sessionTurns' | 'sessionTurnsObservedAt'
>;

/**
 * Merges rollback eligibility from an incoming session snapshot into the stored session.
 *
 * Eligible turn starts describe the server's turns when they were read. The exact read, the turns
 * projection, turn-mutation socket updates and list rows from servers that project starts carry
 * them; a session-list row that omits them says nothing either way. Such a snapshot keeps the
 * known starts for display but marks them stale: a turn mutation the client missed (for example
 * while disconnected) may have changed them, and an eligibility change on an earlier turn touches
 * no list-row field the client could compare. A stale value is confirmed by one exact read when
 * the session is opened or is visible (`needsRollbackEligibilityRead`).
 *
 * Paths that patch a stored session spread it, handing back the very array already stored; every
 * evidence source parses a new one. Identity therefore separates a carried copy (staleness kept)
 * from new evidence (staleness cleared), and the incoming `rollbackEligibilityStale` is ignored.
 *
 * Evidence is also ordered by when it was observed (`rollbackEligibilityObservedAt`, see
 * `nextRollbackEligibilityObservation`): starts observed before the stored evidence are older than
 * it and are dropped, keeping the stored starts and their status. A by-id read that was in flight
 * when a newer turn-mutation update arrived therefore cannot restore what that update revoked, and
 * a session-list row ordered by its request's start keeps that order instead of erasing it.
 * Evidence without an observation (the warm cache) is not ordered and is accepted.
 * Older evidence also keeps the stored turns projection with its observation: a projection
 * fetched before a newer delivered update must not replace the projection stored beside that
 * update's starts. Transcript actions combine the merged starts with the projection by their
 * observations (`resolveTranscriptRollbackActions`).
 */
export function mergeRollbackEligibility(
    previous: RollbackEligibilityFields | null | undefined,
    incoming: RollbackEligibilityFields,
): Readonly<{
    rollbackEligibleTurnStarts: Session['rollbackEligibleTurnStarts'];
    rollbackEligibilityStale: true | undefined;
    rollbackEligibilityObservedAt: number | undefined;
    sessionTurns?: Session['sessionTurns'];
    sessionTurnsObservedAt?: number;
}> {
    const previousStarts = previous?.rollbackEligibleTurnStarts;
    const previousObservedAt = previous?.rollbackEligibilityObservedAt;
    if (incoming.rollbackEligibleTurnStarts === undefined) {
        return {
            rollbackEligibleTurnStarts: previousStarts,
            rollbackEligibilityStale: previousStarts !== undefined ? true : undefined,
            rollbackEligibilityObservedAt: previousObservedAt,
        };
    }
    const incomingObservedAt = incoming.rollbackEligibilityObservedAt;
    const isCarriedCopy = previous != null && incoming.rollbackEligibleTurnStarts === previousStarts;
    const isOlderEvidence = incomingObservedAt !== undefined
        && previousObservedAt !== undefined
        && incomingObservedAt < previousObservedAt;
    if (previous && isOlderEvidence) {
        return {
            rollbackEligibleTurnStarts: previousStarts,
            rollbackEligibilityStale: previous.rollbackEligibilityStale === true ? true : undefined,
            rollbackEligibilityObservedAt: previousObservedAt,
            sessionTurns: previous.sessionTurns,
            sessionTurnsObservedAt: previous.sessionTurnsObservedAt,
        };
    }
    if (previous && isCarriedCopy) {
        return {
            rollbackEligibleTurnStarts: previousStarts,
            rollbackEligibilityStale: previous.rollbackEligibilityStale === true ? true : undefined,
            rollbackEligibilityObservedAt: previousObservedAt,
        };
    }
    return {
        rollbackEligibleTurnStarts: incoming.rollbackEligibleTurnStarts,
        rollbackEligibilityStale: undefined,
        rollbackEligibilityObservedAt: incomingObservedAt,
    };
}

/** True when an applied snapshot turned confirmed eligibility into a stale carried copy. */
export function didRollbackEligibilityBecomeStale(
    previous: RollbackEligibilityFields | null | undefined,
    next: RollbackEligibilityFields | null | undefined,
): boolean {
    return next?.rollbackEligibilityStale === true && previous?.rollbackEligibilityStale !== true;
}
