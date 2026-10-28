import type {
  ConnectedServiceAuthGroupQuotaLimitSelectionV1,
  ConnectedServiceQuotaMeterV1,
} from './connectedServiceSchemas.js';

function readQuotaLimitIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolves the stable allowance identity shared by policy authoring and enforcement. */
export function resolveConnectedServiceQuotaMeterLimitIdentity(
  meter: ConnectedServiceQuotaMeterV1,
): string {
  return readQuotaLimitIdentity(meter.providerLimitId) ?? meter.meterId;
}

/**
 * Applies a pool's allowance selection to provider quota meters.
 *
 * `meterId` remains the compatibility identity for providers which predate
 * `providerLimitId`; multi-allowance providers preserve `providerLimitId`.
 */
export function selectConnectedServiceQuotaMetersForLimitSelection(
  meters: readonly ConnectedServiceQuotaMeterV1[],
  selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): readonly ConnectedServiceQuotaMeterV1[] {
  if (!selection || selection.mode === 'all') return meters;
  const selectedIds = new Set(selection.providerLimitIds);
  return meters.filter((meter) => selectedIds.has(
    resolveConnectedServiceQuotaMeterLimitIdentity(meter),
  ));
}
