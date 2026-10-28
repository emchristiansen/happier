import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { shouldPersistQuotaSnapshot } from './shouldPersistQuotaSnapshot';

function buildSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'primary',
    fetchedAt: 1_000,
    staleAfterMs: 300_000,
    planLabel: 'pro',
    accountLabel: null,
    meters: [
      {
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      },
    ],
    ...overrides,
  };
}

describe('shouldPersistQuotaSnapshot', () => {
  it('persists the first snapshot for a key', () => {
    expect(shouldPersistQuotaSnapshot({
      previous: null,
      incoming: { snapshot: buildSnapshot(), fingerprint: 'a', status: 'ok' },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(true);
  });

  it('suppresses unchanged snapshots inside the freshness interval', () => {
    expect(shouldPersistQuotaSnapshot({
      previous: {
        snapshot: buildSnapshot({ fetchedAt: 1_000 }),
        fingerprint: 'same',
        status: 'ok',
        fetchedAt: 1_000,
      },
      incoming: {
        snapshot: buildSnapshot({ fetchedAt: 2_000 }),
        fingerprint: 'same',
        status: 'ok',
      },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(false);
  });

  it('persists status, remaining threshold, and reset changes', () => {
    const previous = {
      snapshot: buildSnapshot({ fetchedAt: 1_000 }),
      fingerprint: 'same',
      status: 'ok' as const,
      fetchedAt: 1_000,
    };

    expect(shouldPersistQuotaSnapshot({
      previous,
      incoming: { snapshot: buildSnapshot({ fetchedAt: 2_000 }), fingerprint: 'same', status: 'unavailable' },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(true);
    expect(shouldPersistQuotaSnapshot({
      previous,
      incoming: {
        snapshot: buildSnapshot({
          fetchedAt: 2_000,
          meters: [{ ...buildSnapshot().meters[0], remainingPct: 9, utilizationPct: 91 }],
        }),
        fingerprint: 'same',
        status: 'ok',
      },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(true);
    expect(shouldPersistQuotaSnapshot({
      previous,
      incoming: {
        snapshot: buildSnapshot({
          fetchedAt: 2_000,
          meters: [{ ...buildSnapshot().meters[0], resetsAt: 20_000 }],
        }),
        fingerprint: 'same',
        status: 'ok',
      },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(true);
  });

  it('does not let older snapshots overwrite newer state', () => {
    expect(shouldPersistQuotaSnapshot({
      previous: {
        snapshot: buildSnapshot({ fetchedAt: 5_000 }),
        fingerprint: 'old',
        status: 'ok',
        fetchedAt: 5_000,
      },
      incoming: { snapshot: buildSnapshot({ fetchedAt: 4_000 }), fingerprint: 'new', status: 'ok' },
      minFreshnessRefreshMs: 60_000,
    })).toEqual({ persist: false, reason: 'stale' });
  });

  it('lets a current observation replace a future-dated persisted snapshot', () => {
    const nowMs = 1_000_000;
    expect(shouldPersistQuotaSnapshot({
      previous: {
        snapshot: buildSnapshot({ fetchedAt: nowMs + 60_000 }),
        fingerprint: 'poisoned',
        status: 'ok',
        fetchedAt: nowMs + 60_000,
      },
      incoming: {
        snapshot: buildSnapshot({ fetchedAt: nowMs }),
        fingerprint: 'current',
        status: 'ok',
      },
      minFreshnessRefreshMs: 60_000,
      nowMs,
    })).toEqual({ persist: true, reason: 'clock_recovered' });
  });

  it('persists a fresh snapshot that clears a server refresh marker', () => {
    expect(shouldPersistQuotaSnapshot({
      previous: {
        snapshot: buildSnapshot({ fetchedAt: 1_000 }),
        fingerprint: 'same',
        status: 'ok',
        fetchedAt: 1_000,
        refreshRequestedAt: 1_500,
      },
      incoming: { snapshot: buildSnapshot({ fetchedAt: 2_000 }), fingerprint: 'same', status: 'ok' },
      minFreshnessRefreshMs: 60_000,
    }).persist).toBe(true);
  });
});
