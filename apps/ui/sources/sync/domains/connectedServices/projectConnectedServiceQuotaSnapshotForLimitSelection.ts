import {
    selectConnectedServiceQuotaMetersForLimitSelection,
    type ConnectedServiceAuthGroupQuotaLimitSelectionV1,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

/**
 * Projects an account snapshot through the owning pool's allowance policy.
 * Account-level facts (identity, subscription and reset credits) stay intact;
 * only allowance meters are selected.
 */
export function projectConnectedServiceQuotaSnapshotForLimitSelection(
    snapshot: ConnectedServiceQuotaSnapshotV1 | null,
    selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): ConnectedServiceQuotaSnapshotV1 | null {
    if (!snapshot || !selection || selection.mode === 'all') return snapshot;
    return {
        ...snapshot,
        meters: [...selectConnectedServiceQuotaMetersForLimitSelection(snapshot.meters, selection)],
    };
}
