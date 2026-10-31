export type QuotaUtilizationMeterLike = Readonly<{
  status?: 'ok' | 'unavailable' | 'estimated';
  used: number | null;
  limit: number | null;
  utilizationPct: number | null;
  usedPct?: number | null;
  remainingPct?: number | null;
}>;

export function clampQuotaPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function deriveQuotaUtilizationPct(meter: QuotaUtilizationMeterLike): number | null {
  if (meter.status === 'unavailable') return null;
  if (typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct)) {
    return clampQuotaPct(meter.utilizationPct);
  }

  if (typeof meter.usedPct === 'number' && Number.isFinite(meter.usedPct)) {
    return clampQuotaPct(meter.usedPct);
  }

  if (typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)) {
    return clampQuotaPct(100 - meter.remainingPct);
  }

  if (
    typeof meter.used === 'number' &&
    typeof meter.limit === 'number' &&
    Number.isFinite(meter.used) &&
    Number.isFinite(meter.limit) &&
    meter.limit > 0
  ) {
    return clampQuotaPct((meter.used / meter.limit) * 100);
  }

  return null;
}

/** Unavailable observations retain their reset/source facts, but assert no numeric usage. */
export function deriveQuotaMeterValues(meter: QuotaUtilizationMeterLike): Readonly<{
  usedPct: number | null;
  remainingPct: number | null;
  used: number | null;
  limit: number | null;
}> {
  const available = meter.status !== 'unavailable';
  const usedPct = deriveQuotaUtilizationPct(meter);
  const remainingPct = !available ? null
    : typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
    ? clampQuotaPct(meter.remainingPct)
    : usedPct === null ? null : clampQuotaPct(100 - usedPct);
  return { usedPct, remainingPct, used: available ? meter.used : null, limit: available ? meter.limit : null };
}
