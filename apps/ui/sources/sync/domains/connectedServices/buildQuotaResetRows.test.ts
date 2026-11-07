import { describe, expect, it } from 'vitest';

import { ConnectedServiceQuotaRecoveryCreditsV1Schema } from '@happier-dev/protocol';

import { buildQuotaResetRows } from './buildQuotaResetRows';
import type { ResetCountdownDaysFormatter } from './formatResetCountdown';

const formatter: ResetCountdownDaysFormatter = {
    now: () => 'now',
    inDays: ({ days }) => `in ${days}d`,
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

describe('buildQuotaResetRows', () => {
    it('attaches presentation details by credit id without changing the available balance authority', () => {
        const details = {
            saved: { remainingCount: 2, appliesToProviderLimitIds: ['five_hour', 'seven_day'], unavailableReason: 'paused' as const },
            live: { remainingCount: 0, appliesToProviderLimitIds: [], unavailableReason: 'cooldown' as const },
        };
        const rows = buildQuotaResetRows(ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
            kind: 'usage_limit_resets', availableCount: 1,
            credits: [
                { kind: 'usage_limit_reset', status: 'unknown', providerCreditId: 'saved' },
                { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'live' },
            ],
        }), NOW, formatter, details);
        expect(rows).toEqual([
            expect.objectContaining({ key: 'live', canUse: true, consumableCreditId: 'live', details: details.live }),
            expect.objectContaining({ key: 'saved', canUse: false, consumableCreditId: null, details: details.saved }),
        ]);
    });

    it('returns no rows when there are no available credits', () => {
        expect(buildQuotaResetRows(null, NOW, formatter)).toEqual([]);
        expect(buildQuotaResetRows(undefined, NOW, formatter)).toEqual([]);
        expect(
            buildQuotaResetRows(
                ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                    kind: 'usage_limit_resets',
                    availableCount: 0,
                    credits: [],
                }),
                NOW,
                formatter,
            ),
        ).toEqual([]);
    });

    it('builds one aggregate placeholder row when credits are empty but the count is positive', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 2,
                nextExpiresAtMs: NOW + 2 * DAY,
                credits: [],
            }),
            NOW,
            formatter,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: NOW + 2 * DAY,
            countdownLabel: 'in 2d',
        });
        expect(rows[0]?.key).toBeTruthy();
    });

    it('shows saved identified grants without making an unavailable balance actionable', () => {
        const rows = buildQuotaResetRows(ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
            kind: 'usage_limit_resets', availableCount: 0, totalCount: 5,
            credits: [{
                kind: 'usage_limit_reset', status: 'unknown', providerCreditId: 'saved',
                title: 'Claude promotional reset',
                description: '2 resets saved. Applies to weekly limits. Not usable now.',
                appliesToProviderLimitId: 'seven_day', expiresAtMs: NOW + DAY,
            }],
        }), NOW, formatter);
        expect(rows).toEqual([expect.objectContaining({
            key: 'saved', consumableCreditId: null, canUse: false, isAggregate: false,
            title: 'Claude promotional reset',
            description: '2 resets saved. Applies to weekly limits. Not usable now.',
            countdownLabel: 'in 1d',
        })]);
    });

    it('keeps saved grants separate from available detail and aggregate capacity', () => {
        const rows = buildQuotaResetRows(ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
            kind: 'usage_limit_resets', availableCount: 2, totalCount: 6,
            credits: [
                { kind: 'usage_limit_reset', status: 'unknown', providerCreditId: 'saved' },
                { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'live' },
            ],
        }), NOW, formatter);
        expect(rows.filter((row) => row.canUse).map((row) => row.consumableCreditId)).toEqual(['live', null]);
        expect(rows.filter((row) => !row.canUse)).toEqual([expect.objectContaining({ key: 'saved', consumableCreditId: null })]);
    });

    it('does not show expired or unidentified unknown grants or infer saved grants from historical total', () => {
        const rows = buildQuotaResetRows(ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
            kind: 'usage_limit_resets', availableCount: 0, totalCount: 9,
            credits: [
                { kind: 'usage_limit_reset', status: 'unknown', providerCreditId: 'expired', expiresAtMs: NOW },
                { kind: 'usage_limit_reset', status: 'unknown' },
                { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'stale' },
                { kind: 'usage_limit_reset', status: 'redeemed', providerCreditId: 'used' },
            ],
        }), NOW, formatter);
        expect(rows).toEqual([]);
    });

    it('builds per-credit rows keyed and gated on providerCreditId', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 2,
                credits: [
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-a', expiresAtMs: NOW + DAY },
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-b', expiresAtMs: NOW + 3 * DAY },
                ],
            }),
            NOW,
            formatter,
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            key: 'credit-a',
            consumableCreditId: 'credit-a',
            canUse: true,
            isAggregate: false,
            countdownLabel: 'in 1d',
        });
        expect(rows[1]).toMatchObject({ key: 'credit-b', consumableCreditId: 'credit-b', canUse: true, countdownLabel: 'in 3d' });
    });

    it('filters out redeemed and expired credits', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 3,
                credits: [
                    { kind: 'usage_limit_reset', status: 'redeemed', providerCreditId: 'gone', expiresAtMs: NOW + DAY },
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'expired', expiresAtMs: NOW - DAY },
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'live', expiresAtMs: NOW + DAY },
                ],
            }),
            NOW,
            formatter,
        );
        expect(rows.map((row) => row.consumableCreditId)).toEqual(['live', null]);
    });

    it('preserves aggregate redemption when an available detail lacks a provider credit id', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 1,
                credits: [{ kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW + DAY }],
            }),
            NOW,
            formatter,
        );
        expect(rows).toEqual([expect.objectContaining({
            key: 'aggregate-remainder',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
        })]);
    });

    it('keeps an aggregate affordance when every capped detail row is unavailable but total remains positive', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 1,
                credits: [{ kind: 'usage_limit_reset', status: 'redeemed', providerCreditId: 'gone' }],
            }),
            NOW,
            formatter,
        );
        expect(rows).toEqual([expect.objectContaining({
            key: 'aggregate-remainder',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
        })]);
    });

    it('retains an aggregate remainder when the authoritative total exceeds capped detail rows', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 3,
                nextExpiresAtMs: NOW + 4 * DAY,
                credits: [
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-a', expiresAtMs: NOW + DAY },
                ],
            }),
            NOW,
            formatter,
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ consumableCreditId: 'credit-a', isAggregate: false });
        expect(rows[1]).toMatchObject({ key: 'aggregate-remainder', consumableCreditId: null, canUse: true, isAggregate: true });
    });

    it('caps individually actionable detail rows at the authoritative available count', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 1,
                credits: [
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-a' },
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-b' },
                ],
            }), NOW, formatter,
        );
        expect(rows.map((row) => row.consumableCreditId)).toEqual(['credit-a']);
    });

    it('does not let missing-id details consume aggregate remainder capacity', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                kind: 'usage_limit_resets',
                availableCount: 2,
                credits: [
                    { kind: 'usage_limit_reset', status: 'available' },
                    { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'credit-a' },
                ],
            }), NOW, formatter,
        );
        expect(rows.map((row) => row.consumableCreditId)).toEqual(['credit-a', null]);
    });
});
