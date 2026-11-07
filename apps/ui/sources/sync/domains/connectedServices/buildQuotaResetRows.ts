import type {
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaRecoveryCreditDetailsV1,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1,
} from '@happier-dev/protocol';

import { formatResetCountdownDays, type ResetCountdownDaysFormatter } from './formatResetCountdown';
import { isAvailableRecoveryCredit } from './connectedServiceQuotaRecoveryCreditSummary';

export type QuotaResetRow = Readonly<{
    /** Provider credit id, or the stable aggregate key. */
    key: string;
    /** Actionable provider credit id; `null` for aggregate or informational rows. */
    consumableCreditId: string | null;
    /** Whether the provider reports this credit as actionable. */
    canUse: boolean;
    /** True for the available count not covered by individually actionable details. */
    isAggregate: boolean;
    expiresAtMs: number | null;
    countdownLabel: string | null;
    title?: string | null;
    description?: string | null;
    details?: ConnectedServiceQuotaRecoveryCreditDetailsV1;
}>;

function readProviderCreditId(credit: ConnectedServiceQuotaRecoveryCreditV1): string | null {
    const raw = typeof credit.providerCreditId === 'string' ? credit.providerCreditId.trim() : '';
    return raw.length > 0 ? raw : null;
}

function normalizeFutureExpiry(expiresAtMs: number | null | undefined, nowMs: number): number | null {
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return null;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

/**
 * Build per-credit QUOTA RESETS rows from a recovery-credit summary.
 *
 * - Identified, unexpired unknown credits are informational disabled rows.
 * - Empty `credits[]` + positive `availableCount` ⇒ one aggregate placeholder
 *   row (`consumableCreditId: null`, `canUse: true`) consumed via the summary.
 * - Detailed credits ⇒ at most `availableCount` individually consumable rows.
 *   Missing-id and undisclosed/capped credits remain reachable through one
 *   aggregate-remainder row instead of consuming an unusable detail slot.
 */
export function buildQuotaResetRows(
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
    nowMs: number,
    formatter: ResetCountdownDaysFormatter,
    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1,
): QuotaResetRow[] {
    if (!recoveryCredits) return [];

    const detailedCredits = Array.isArray(recoveryCredits.credits) ? recoveryCredits.credits : [];

    if (detailedCredits.length === 0) {
        if (recoveryCredits.availableCount <= 0) return [];
        const expiresAtMs = normalizeFutureExpiry(recoveryCredits.nextExpiresAtMs, nowMs);
        return [{
            key: 'aggregate',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
        }];
    }

    const individuallyConsumableCredits = detailedCredits
        .filter((credit) => isAvailableRecoveryCredit(credit, nowMs))
        .map((credit) => ({ credit, consumableCreditId: readProviderCreditId(credit) }))
        .filter((entry): entry is Readonly<{
            credit: ConnectedServiceQuotaRecoveryCreditV1;
            consumableCreditId: string;
        }> => entry.consumableCreditId !== null)
        .slice(0, recoveryCredits.availableCount);
    const rows: QuotaResetRow[] = individuallyConsumableCredits.map(({ credit, consumableCreditId }) => {
        const expiresAtMs = normalizeFutureExpiry(credit.expiresAtMs, nowMs);
        return {
            key: consumableCreditId,
            consumableCreditId,
            canUse: true,
            isAggregate: false,
            expiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
            title: credit.title ?? null,
            description: credit.description ?? null,
            ...(recoveryCreditDetails?.[consumableCreditId] ? { details: recoveryCreditDetails[consumableCreditId] } : {}),
        };
    });
    const aggregateRemainder = Math.max(0, recoveryCredits.availableCount - individuallyConsumableCredits.length);
    if (aggregateRemainder > 0) {
        const expiresAtMs = normalizeFutureExpiry(recoveryCredits.nextExpiresAtMs, nowMs);
        rows.push({
            key: 'aggregate-remainder',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
        });
    }
    for (const credit of detailedCredits) {
        if (credit.status !== 'unknown') continue;
        const creditId = readProviderCreditId(credit);
        if (!creditId || (typeof credit.expiresAtMs === 'number' && credit.expiresAtMs <= nowMs)) continue;
        const expiresAtMs = normalizeFutureExpiry(credit.expiresAtMs, nowMs);
        rows.push({
            key: creditId,
            consumableCreditId: null,
            canUse: false,
            isAggregate: false,
            expiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
            title: credit.title ?? null,
            description: credit.description ?? null,
            ...(recoveryCreditDetails?.[creditId] ? { details: recoveryCreditDetails[creditId] } : {}),
        });
    }
    return rows;
}
