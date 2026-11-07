import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { deriveQuotaMeterValues, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';
import {
  isConnectedServiceQuotaMeterPercentRankable,
  selectComparableConnectedServiceQuotaMeters,
} from './connectedServiceQuotaGauge';
import { summarizeConnectedServiceQuotaRecoveryCredits } from './connectedServiceQuotaRecoveryCreditSummary';

function resolveQuotaBadgeMeterContext(params: Readonly<{
  meterId: string;
  label: string | null | undefined;
}>): string {
  const label = typeof params.label === 'string' ? params.label.trim() : '';
  return label.length > 0 ? label : params.meterId;
}

export function computeConnectedServiceQuotaSummaryBadges(params: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1 | null;
  pinnedMeterIds: ReadonlyArray<string>;
  strategy?: 'primary' | 'min_remaining';
  nowMs?: number | null;
  formatRecoveryCreditBadge?: (params: Readonly<{ count: number }>) => string;
}>): Array<{ meterId: string; text: string }> {
  const meters = params.snapshot?.meters ?? [];
  const defaultMeterIds = selectComparableConnectedServiceQuotaMeters(meters)
    .slice()
    .sort((a, b) => {
      const aUtilization = deriveQuotaUtilizationPct(a) ?? Number.NEGATIVE_INFINITY;
      const bUtilization = deriveQuotaUtilizationPct(b) ?? Number.NEGATIVE_INFINITY;
      return bUtilization - aUtilization;
    })
    .slice(0, 1)
    .map((meter) => meter.meterId);
  const meterIds = params.pinnedMeterIds.length > 0 ? params.pinnedMeterIds : defaultMeterIds;
  if (meterIds.length === 0) return [];

  const includeMeterContext = meterIds.length > 1;

  const badgesWithMeta = meterIds.map((meterId, index) => {
    const meter = meters.find((m) => m.meterId === meterId) ?? null;
    const remainingPct = meter ? deriveQuotaMeterValues(meter).remainingPct : null;
    const valueText = remainingPct === null ? '—' : `${Math.round(remainingPct)}%`;
    const context = includeMeterContext
      ? resolveQuotaBadgeMeterContext({ meterId, label: meter?.label })
      : null;
    const text = context ? `${context} ${valueText}` : valueText;
    return { meterId, text, remainingPct, rankable: meter ? isConnectedServiceQuotaMeterPercentRankable(meter) : false, index };
  });

  const strategy = params.strategy ?? 'primary';
  if (strategy === 'min_remaining') {
    const comparableMeterIds = new Set(selectComparableConnectedServiceQuotaMeters(meters).map((meter) => meter.meterId));
    const meterBadges = badgesWithMeta
      .slice()
      .sort((a, b) => {
        const aScore = a.rankable && comparableMeterIds.has(a.meterId) && a.remainingPct !== null ? a.remainingPct : Number.POSITIVE_INFINITY;
        const bScore = b.rankable && comparableMeterIds.has(b.meterId) && b.remainingPct !== null ? b.remainingPct : Number.POSITIVE_INFINITY;
        if (aScore !== bScore) return aScore - bScore;
        return a.index - b.index;
      })
      .map(({ meterId, text }) => ({ meterId, text }));
    const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(params.snapshot?.recoveryCredits, params.nowMs);
    return recoveryCreditSummary && params.formatRecoveryCreditBadge
      ? [
        ...meterBadges,
        {
          meterId: 'recovery_credits',
          text: params.formatRecoveryCreditBadge({ count: recoveryCreditSummary.availableCount }),
        },
      ]
      : meterBadges;
  }

  const meterBadges = badgesWithMeta.map(({ meterId, text }) => ({ meterId, text }));
  const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(params.snapshot?.recoveryCredits, params.nowMs);
  return recoveryCreditSummary && params.formatRecoveryCreditBadge
    ? [
      ...meterBadges,
      {
        meterId: 'recovery_credits',
        text: params.formatRecoveryCreditBadge({ count: recoveryCreditSummary.availableCount }),
      },
    ]
    : meterBadges;
}
