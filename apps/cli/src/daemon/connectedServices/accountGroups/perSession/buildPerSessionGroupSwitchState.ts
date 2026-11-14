import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildConnectedServiceAuthGroupSwitchState,
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from '../switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from '../switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import type { ConnectedServiceAuthGroupSwitchState } from '../switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceMemberHoldView } from '../holds/connectedServiceMemberHolds';

/**
 * Score state for a per-session draw (spawn or failover). A per-session decision moves no shared
 * pointer, so it may use the daemon's runtime quota snapshots when account usage is not yet
 * source-backed (cold store); without either, members carry only persisted state and a draw that
 * requires known scores refuses rather than imputing quota.
 */
export function buildPerSessionGroupSwitchState(params: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  nowMs: number;
  /** Current member holds; every per-session eligibility check and draw excludes held members. */
  memberHolds: ConnectedServiceMemberHoldView;
}>): ConnectedServiceAuthGroupSwitchState {
  if (params.accountUsageStore) {
    const accountUsageSwitchState = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: params.group,
      accountUsageStore: params.accountUsageStore,
      memberHolds: params.memberHolds,
    });
    if (accountUsageSwitchState.kind === 'source_backed') return accountUsageSwitchState.state;
  }
  if (params.runtimeQuotaSnapshots) {
    return buildConnectedServiceAuthGroupSwitchState({
      group: params.group,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
      nowMs: params.nowMs,
      memberHolds: params.memberHolds,
    });
  }
  return buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group: params.group, memberHolds: params.memberHolds });
}
