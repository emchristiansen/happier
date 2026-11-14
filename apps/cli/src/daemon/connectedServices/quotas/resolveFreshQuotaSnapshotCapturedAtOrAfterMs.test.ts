import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { resolveFreshQuotaSnapshotCapturedAtOrAfterMs } from './resolveFreshQuotaSnapshotCapturedAtOrAfterMs';

const meter = {
  meterId: 'five_hour', label: '5-hour', used: null, limit: null, unit: 'requests' as const, utilizationPct: 20, resetsAt: null, status: 'ok' as const, details: {},
};
const base: ConnectedServiceQuotaSnapshotV1 = {
  v: 1, serviceId: 'claude-subscription', profileId: 'a', fetchedAt: 1_000, staleAfterMs: 300, planLabel: null, accountLabel: null, meters: [meter],
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

  it('a no-fetch placeholder with only unavailable meters proves no capture (HPI-29)', () => {
    const unknown = { ...meter, unit: 'unknown' as const, utilizationPct: null, status: 'unavailable' as const, details: { code: 'quota_unknown' } };
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [unknown, unknown] }, 1_100)).toBeNull();
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [] }, 1_100)).toBeNull();
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [unknown, meter] }, 1_100)).toBe(1_000);
  });

  it('a fetched amount is a capture even when its percentage is unavailable (HPI-34)', () => {
    const usedOnly = { ...meter, utilizationPct: null, used: 4, status: 'unavailable' as const };
    const credits = { ...meter, meterId: 'extra_usage', unit: 'credits' as const, utilizationPct: null, used: 20, limit: 100, status: 'unavailable' as const };
    const limitOnly = { ...meter, utilizationPct: null, limit: 100, status: 'unavailable' as const };
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [usedOnly] }, 1_100)).toBe(1_000);
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [credits] }, 1_100)).toBe(1_000);
    expect(resolveFreshQuotaSnapshotCapturedAtOrAfterMs({ ...base, meters: [limitOnly] }, 1_100)).toBeNull();
  });
});
