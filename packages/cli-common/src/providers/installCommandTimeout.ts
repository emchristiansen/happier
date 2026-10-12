/**
 * The budget for one provider install/update command (vendor recipe, native updater,
 * managed pnpm): `HAPPIER_VENDOR_INSTALL_TIMEOUT_MS`, default 180 s, capped at 15 min,
 * `0` disables it.
 */
export function resolveProviderInstallCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS === 'string'
    ? env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS.trim()
    : '';
  if (raw === '0') return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) return 180_000;
  return Math.min(parsed, 900_000);
}
