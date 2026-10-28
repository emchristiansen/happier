import {
  compareConnectedServiceQuotaObservationRecency,
  isConnectedServiceQuotaObservationAtOrBeforeNow,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export type ShouldPersistQuotaSnapshotStatus = 'ok' | 'unavailable' | 'estimated' | 'error';

export function shouldPersistQuotaSnapshot(input: Readonly<{
  previous: null | Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1;
    fingerprint: string | null;
    status: ShouldPersistQuotaSnapshotStatus;
    fetchedAt: number;
    refreshRequestedAt?: number;
  }>;
  incoming: Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1;
    fingerprint: string | null;
    status: ShouldPersistQuotaSnapshotStatus;
  }>;
  minFreshnessRefreshMs: number;
  nowMs?: number;
}>): Readonly<{ persist: boolean; reason: string }> {
  const nowMs = readFiniteNonNegative(input.nowMs) ?? Date.now();
  const incomingFetchedAt = readFetchedAt(input.incoming.snapshot);
  if (!isConnectedServiceQuotaObservationAtOrBeforeNow({ observedAtMs: incomingFetchedAt, nowMs })) {
    return { persist: false, reason: 'future' };
  }
  const previous = input.previous;
  if (!previous) return { persist: true, reason: 'first_snapshot' };

  const previousFetchedAt = Number.isFinite(previous.fetchedAt)
    ? previous.fetchedAt
    : readFetchedAt(previous.snapshot);
  const recency = compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: previousFetchedAt,
    incomingObservedAtMs: incomingFetchedAt,
    nowMs,
  });
  if (recency === 'incoming_older') return { persist: false, reason: 'stale' };
  if (!isConnectedServiceQuotaObservationAtOrBeforeNow({ observedAtMs: previousFetchedAt, nowMs })) {
    return { persist: true, reason: 'clock_recovered' };
  }

  const refreshRequestedAt = readFiniteNonNegative(previous.refreshRequestedAt);
  if (refreshRequestedAt !== null && refreshRequestedAt > previousFetchedAt && incomingFetchedAt >= refreshRequestedAt) {
    return { persist: true, reason: 'refresh_marker' };
  }

  if (previous.status !== input.incoming.status) return { persist: true, reason: 'status' };
  if (previous.fingerprint && input.incoming.fingerprint && previous.fingerprint !== input.incoming.fingerprint) {
    return { persist: true, reason: 'fingerprint' };
  }
  if (resetIdentity(previous.snapshot) !== resetIdentity(input.incoming.snapshot)) {
    return { persist: true, reason: 'reset_window' };
  }
  if (crossedRemainingThreshold(previous.snapshot, input.incoming.snapshot)) {
    return { persist: true, reason: 'remaining_threshold' };
  }

  const minFreshnessRefreshMs = Math.max(0, Math.trunc(input.minFreshnessRefreshMs));
  if (incomingFetchedAt - previousFetchedAt >= minFreshnessRefreshMs) {
    return { persist: true, reason: 'freshness' };
  }

  return { persist: false, reason: 'unchanged' };
}

function readFiniteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readFetchedAt(snapshot: ConnectedServiceQuotaSnapshotV1): number {
  return readFiniteNonNegative(snapshot.fetchedAt) ?? 0;
}

function resetIdentity(snapshot: ConnectedServiceQuotaSnapshotV1): string {
  return snapshot.meters
    .map((meter) => [
      meter.meterId,
      meter.providerLimitId ?? '',
      meter.resetAtMs ?? meter.resetsAt ?? '',
      meter.resetSource ?? '',
      meter.details?.providerLimitId ?? '',
    ].join(':'))
    .sort()
    .join('|');
}

function readEffectiveRemainingPct(snapshot: ConnectedServiceQuotaSnapshotV1): number | null {
  const values = snapshot.meters
    .map((meter) => {
      if (typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)) return meter.remainingPct;
      if (typeof meter.details?.remainingPct === 'number' && Number.isFinite(meter.details.remainingPct)) return meter.details.remainingPct;
      if (typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct)) return 100 - meter.utilizationPct;
      return null;
    })
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, Math.min(100, value)));
  if (values.length === 0) return null;
  return Math.min(...values);
}

function thresholdBucket(value: number | null): string {
  if (value === null) return 'unknown';
  if (value <= 0) return 'exhausted';
  if (value <= 10) return 'critical';
  if (value <= 20) return 'warning';
  return 'ok';
}

function crossedRemainingThreshold(
  previous: ConnectedServiceQuotaSnapshotV1,
  incoming: ConnectedServiceQuotaSnapshotV1,
): boolean {
  return thresholdBucket(readEffectiveRemainingPct(previous)) !== thresholdBucket(readEffectiveRemainingPct(incoming));
}
