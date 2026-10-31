import type {
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol';

export type ConnectedServiceQuotaRecoveryCreditSummary = Readonly<{
    availableCount: number;
    nextExpiresAtMs: number | null;
    providerCreditId: string | null;
}>;

export function isAvailableRecoveryCredit(
    credit: ConnectedServiceQuotaRecoveryCreditV1,
    nowMs: number | null | undefined,
): boolean {
    if (credit.status !== 'available') return false;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return true;
    return typeof credit.expiresAtMs !== 'number' || credit.expiresAtMs > nowMs;
}

function normalizeFutureExpiry(
    expiresAtMs: number | null | undefined,
    nowMs: number | null | undefined,
): number | null {
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return null;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return expiresAtMs;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

export function summarizeConnectedServiceQuotaRecoveryCredits(
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
    nowMs: number | null | undefined,
): ConnectedServiceQuotaRecoveryCreditSummary | null {
    if (!recoveryCredits || recoveryCredits.availableCount <= 0) return null;
    const detailedCredits = Array.isArray(recoveryCredits.credits) ? recoveryCredits.credits : [];
    const availableCredits = detailedCredits.filter((credit) => isAvailableRecoveryCredit(credit, nowMs));
    const availableCount = recoveryCredits.availableCount;
    if (availableCount <= 0) return null;

    const expiries = availableCredits
        .map((credit) => credit.expiresAtMs)
        .map((value) => normalizeFutureExpiry(value, nowMs))
        .filter((value): value is number => value !== null);
    const nextExpiresAtMs = expiries.length > 0
        ? Math.min(...expiries)
        : normalizeFutureExpiry(recoveryCredits.nextExpiresAtMs, nowMs);
    const providerCreditId = availableCredits
        .map((credit) => typeof credit.providerCreditId === 'string' ? credit.providerCreditId.trim() : '')
        .find((value) => value.length > 0) ?? null;

    return {
        availableCount,
        nextExpiresAtMs,
        providerCreditId,
    };
}
