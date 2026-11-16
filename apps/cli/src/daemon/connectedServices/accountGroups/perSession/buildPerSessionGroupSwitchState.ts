import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildConnectedServiceAuthGroupSwitchState,
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
  mergePersistedMemberRuntimeState,
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
  const runtimeState = params.runtimeQuotaSnapshots
    ? buildConnectedServiceAuthGroupSwitchState({
      group: params.group,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
      nowMs: params.nowMs,
      memberHolds: params.memberHolds,
    })
    : null;
  if (params.accountUsageStore) {
    const accountUsage = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: params.group,
      accountUsageStore: params.accountUsageStore,
      memberHolds: params.memberHolds,
    });
    if (accountUsage.kind === 'source_backed') {
      if (!runtimeState) return accountUsage.state;
      // Per member: an account-usage record wins; a member without one keeps its runtime quota
      // snapshot. One member's record (for example after its classified failure) must not erase the
      // other members' scores and push a failover draw into the unknown-score fallback.
      const memberStatesByProfileId = new Map(accountUsage.state.memberStatesByProfileId);
      for (const member of params.group.members) {
        const profileId = member.profileId.trim();
        if (!profileId || accountUsage.sourceRefsByProfileId.has(profileId)) continue;
        memberStatesByProfileId.set(
          profileId,
          runtimeState.memberStatesByProfileId.get(member.profileId)
            ?? mergePersistedMemberRuntimeState(null, member.state),
        );
      }
      return { ...accountUsage.state, memberStatesByProfileId };
    }
  }
  return runtimeState
    ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group: params.group, memberHolds: params.memberHolds });
}
