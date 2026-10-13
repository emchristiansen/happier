import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { isRecord } from '@/daemon/connectedServices/quotas/quotaNormalization';

/** Installed 0.2.12 window mapping: duration, never provider slot, establishes identity. */
export function normalizeCodexQuotaWindows(
  rateLimit: Record<string, unknown> | null,
  now: number,
  normalizePct: (value: unknown) => number | null,
  normalizeReset: (window: Record<string, unknown> | null, now: number) => number | null,
): ConnectedServiceQuotaMeterV1[] {
  const windows = (['primary_window', 'secondary_window'] as const).flatMap((position) => {
    const window = rateLimit?.[position];
    if (!isRecord(window)) return [];
    const rawDuration = window.limit_window_seconds;
    const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
    const identity = duration === 18000 ? 'session' : duration === 604800 ? 'weekly' : null;
    const durationState = identity ? 'recognized' : duration !== null ? 'unrecognized' : rawDuration === undefined ? 'missing' : 'invalid';
    return [{ position, window, duration, identity, durationState }];
  });
  if (!windows.length) return [{
    meterId: 'codex_unknown', label: 'Quota (no window data)', used: null, limit: null,
    unit: 'unknown', utilizationPct: null, resetsAt: null, status: 'unavailable',
    details: { code: 'quota_unknown', note: 'No primary or secondary window supplied' },
  }];
  return windows.map(({ position, window, duration, identity, durationState }) => {
    const duplicate = identity && windows.filter((other) => other.identity === identity).length > 1;
    const meterId = identity ? identity + (duplicate ? '_' + position : '') : 'codex_' + position;
    const name = identity === 'session' ? '5-hour' : identity === 'weekly' ? 'Weekly' : 'Unknown-duration window';
    const rawUsage = window.used_percent;
    const utilizationPct = typeof rawUsage === 'number' && Number.isFinite(rawUsage) ? normalizePct(rawUsage) : null;
    return {
      meterId, label: name + (duplicate || !identity ? ' (' + position + ')' : ''),
      used: null, limit: null, unit: 'unknown', utilizationPct,
      resetsAt: normalizeReset(window, now), status: utilizationPct === null ? 'unavailable' : 'ok',
      details: { rawScope: position, note: JSON.stringify({ providerWindow: position, limitWindowSeconds: duration, durationState }) },
    };
  });
}
