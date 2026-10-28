function parsePositiveIntEnv(raw: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

export function readConnectedServiceQuotaStaleAfterMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS, 30 * 60_000, {
    min: 5_000,
    max: 24 * 60 * 60_000,
  });
}
