import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { resolveFreshQuotaSnapshotCapturedAtOrAfterMs } from './resolveFreshQuotaSnapshotCapturedAtOrAfterMs';

const base: ConnectedServiceQuotaSnapshotV1 = {
  v: 1, serviceId: 'claude-subscription', profileId: 'a', fetchedAt: 1_000, staleAfterMs: 300, planLabel: null, accountLabel: null, meters: [],
};

describe('quota snapshot capture evidence for reservation release (spec A.3)', () => {
  it('an endpoint fetch is captured no earlier than its request while fresh', () => {
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs(base, 1_100)).toBe(1_000);
  });

  it('an expired snapshot proves nothing, whatever its times (HPI-24)', () => {
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs(base, 1_300)).toBeNull();
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, staleAtMs: 1_050 }, 1_100)).toBeNull();
  });

  it('an in-band observation proves only the capture time the provider stated, never receipt (HPI-25)', () => {
    const inBand = { ...base, source: 'in_band_provider_snapshot' as const };
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs(inBand, 1_100)).toBeNull();
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...inBand, evidence: { observedAtMs: 900 } }, 1_100)).toBe(900);
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, source: 'cached' }, 1_100)).toBeNull();
  });
});
