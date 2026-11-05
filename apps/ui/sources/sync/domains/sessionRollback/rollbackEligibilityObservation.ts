let lastObservation = 0;

/**
 * Client-local order of rollback-eligibility observations. A reader takes one when its request
 * starts; a turn-mutation socket update takes one when it is received. Evidence observed earlier
 * than the stored evidence cannot replace it (`mergeRollbackEligibility`), so a read that was
 * already in flight when a newer revocation arrived cannot restore revoked starts.
 */
export function nextRollbackEligibilityObservation(): number {
    lastObservation += 1;
    return lastObservation;
}
