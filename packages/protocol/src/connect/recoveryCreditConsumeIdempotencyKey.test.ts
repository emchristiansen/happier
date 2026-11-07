import { describe, expect, it } from 'vitest';

import { buildRecoveryCreditConsumeIdempotencyKey } from './recoveryCreditConsumeIdempotencyKey.js';

describe('recovery-credit consumption identity', () => {
    const credit = { serviceId: 'claude-subscription', profileId: 'work', providerCreditId: 'cedar_ember:grant' } as const;

    it('replays one inventory observation and distinguishes a later use of the same credit', () => {
        const first = buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: 1_000 });
        expect(buildRecoveryCreditConsumeIdempotencyKey({
            ...credit, providerCreditId: ` ${credit.providerCreditId} `, sourceSnapshotFetchedAtMs: 1_000.9,
        })).toBe(first);
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: 2_000 })).not.toBe(first);
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, providerCreditId: 'juniper_tide', sourceSnapshotFetchedAtMs: 1_000 })).not.toBe(first);
    });

    it('preserves released no-basis keys without colliding with snapshot observations', () => {
        // cli-v0.2.15 uses this no-basis shape; RPC keys remain opaque caller input.
        const released = `connected-service-quota-recovery-credit:v1:${credit.serviceId}:${credit.profileId}:credit:${credit.providerCreditId}`;
        for (const sourceSnapshotFetchedAtMs of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs })).toBe(released);
        }
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: 1_000 })).not.toBe(released);
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: -1 })).toBe(
            buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: 0 }),
        );
        expect(buildRecoveryCreditConsumeIdempotencyKey({ ...credit, sourceSnapshotFetchedAtMs: 1_000 })).not.toBe(
            buildRecoveryCreditConsumeIdempotencyKey({ ...credit, providerCreditId: `${credit.providerCreditId}:snapshot:1000` }),
        );
    });
});
