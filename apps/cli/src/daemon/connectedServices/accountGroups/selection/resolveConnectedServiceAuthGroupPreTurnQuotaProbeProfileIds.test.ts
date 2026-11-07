import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from './selectConnectedServiceAuthGroupCandidate';

describe('resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds', () => {
  it('probes a profile whose retained quota observation is dated in the future', () => {
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: 'active',
      members: [{ profileId: 'active', priority: 1, createdAtMs: 1, enabled: true }],
      memberStatesByProfileId: new Map([[
        'active',
        { quotaSnapshot: { capturedAtMs: 10_000, effectiveMeterId: 'weekly', effectiveRemainingPercent: 0 } },
      ]]),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        preTurnProbeMode: 'when_stale',
      },
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      allowCurrentProfileRetry: true,
    })).toEqual(['active']);
  });
});
