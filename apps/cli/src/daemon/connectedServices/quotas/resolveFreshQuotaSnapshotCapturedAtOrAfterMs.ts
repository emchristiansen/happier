import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

/** Producers that stamp receipt time into `fetchedAt`; only a provider-stated time proves capture. */
const RECEIPT_STAMPED_SOURCES: ReadonlySet<string> = new Set(['runtime_event', 'in_band_snapshot', 'in_band_provider_snapshot']);
/** Copies of earlier observations, whose own capture time is not recorded. */
const UNTIMED_SOURCES: ReadonlySet<string> = new Set(['cached', 'unknown']);

/**
 * Whether a meter carries a quota value the provider reported. `status` is not consulted: producers
 * mark a meter unavailable when only its percentage cannot be derived, while still carrying a fetched
 * amount (HPI-34). A placeholder that fetched nothing has no value at all. A limit alone is not usage.
 */
function isCapturedMeter(meter: ConnectedServiceQuotaSnapshotV1['meters'][number]): boolean {
  return [meter.utilizationPct, meter.remainingPct, meter.usedPct, meter.used, meter.remaining]
    .some((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * The earliest time a still-fresh quota snapshot can have been captured at, or null when it is
 * expired or carries no capture proof (spec A.3: the first fresh snapshot captured after provider
 * activity). An endpoint fetch is captured no earlier than its request (`fetchedAt`); an in-band
 * observation only at the time the provider stated (`evidence.observedAtMs`), never its receipt.
 * A snapshot with no reported quota value (only unavailable placeholders, e.g. a disabled endpoint
 * that fetched nothing) captured nothing and proves nothing.
 */
export function resolveFreshQuotaSnapshotCapturedAtOrAfterMs(snapshot: ConnectedServiceQuotaSnapshotV1, nowMs: number): number | null {
  const fetchedAt = snapshot.fetchedAtMs ?? snapshot.fetchedAt;
  const staleAtMs = snapshot.staleAtMs ?? fetchedAt + snapshot.staleAfterMs;
  if (!(nowMs < staleAtMs)) return null;
  if (!snapshot.meters.some(isCapturedMeter)) return null;
  const source = snapshot.source;
  if (source && UNTIMED_SOURCES.has(source)) return null;
  if (source && RECEIPT_STAMPED_SOURCES.has(source)) return snapshot.evidence?.observedAtMs ?? null;
  return fetchedAt > 0 ? fetchedAt : null;
}
