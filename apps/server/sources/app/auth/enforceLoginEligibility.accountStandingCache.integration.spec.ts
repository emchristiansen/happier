import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { accountDisabledKey, disableAccount } from "@/app/auth/accountDisable";
import { ACCOUNT_STANDING_CACHE_TTL_MS } from "@/app/auth/accountStandingCache";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

// Statements are counted with Prisma's own datasource counter rather than spies: spying on a Prisma model
// delegate through the `db` proxy does not call through to the real query.
async function datasourceStatementCount(): Promise<number> {
    const metrics = await db.$metrics.json();
    const counter = metrics.counters.find((c) => c.key === "prisma_datasource_queries_total");
    if (!counter) throw new Error("prisma_datasource_queries_total counter is missing");
    return counter.value;
}

async function statementsDuring(fn: () => Promise<unknown>): Promise<number> {
    const before = await datasourceStatementCount();
    await fn();
    return (await datasourceStatementCount()) - before;
}

describe("enforceLoginEligibility (account standing cache)", () => {
    let harness: LightSqliteHarness;
    let nextKeyByte = 40;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-eligibility-cache-",
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await harness.close();
    });

    function nextPublicKey(): string {
        return privacyKit.encodeHex(new Uint8Array(32).fill(nextKeyByte++));
    }

    async function createAccount(): Promise<string> {
        const account = await db.account.create({ data: { publicKey: nextPublicKey() }, select: { id: true } });
        return account.id;
    }

    function advanceMonotonicClock(ms: number): void {
        const realNow = performance.now.bind(performance);
        vi.spyOn(performance, "now").mockImplementation(() => realNow() + ms);
    }

    const check = (accountId: string) => enforceLoginEligibility({ accountId, env: process.env });

    it("does not repeat the account and disabled-marker lookups within the bound", async () => {
        const accountId = await createAccount();

        expect(await statementsDuring(() => expect(check(accountId)).resolves.toEqual({ ok: true }))).toBe(2);
        for (let i = 0; i < 4; i += 1) {
            expect(await statementsDuring(() => expect(check(accountId)).resolves.toEqual({ ok: true }))).toBe(0);
        }
    });

    it("lets overlapping requests share one pair of lookups", async () => {
        const accountId = await createAccount();

        // Start each request on its own macrotask. Prisma batches findUnique calls made in the same tick into
        // one statement, so requests started together would share statements even without this cache.
        let results: unknown[] = [];
        const statements = await statementsDuring(async () => {
            const pending: Promise<unknown>[] = [];
            for (let i = 0; i < 8; i += 1) {
                pending.push(check(accountId));
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            results = await Promise.all(pending);
        });

        expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
        expect(statements).toBe(2);
    });

    it("looks the account up again once the bound has passed", async () => {
        const accountId = await createAccount();
        await expect(check(accountId)).resolves.toEqual({ ok: true });

        advanceMonotonicClock(ACCOUNT_STANDING_CACHE_TTL_MS);

        expect(await statementsDuring(() => expect(check(accountId)).resolves.toEqual({ ok: true }))).toBe(2);
    });

    it("applies disableAccount to the very next check in this process", async () => {
        const accountId = await createAccount();
        await expect(check(accountId)).resolves.toEqual({ ok: true });

        await disableAccount({ accountId, reason: "test", env: process.env });

        await expect(check(accountId)).resolves.toEqual({ ok: false, statusCode: 403, error: "account-disabled" });
    });

    it("does not cache a disabled result, so clearing the marker applies to the next check", async () => {
        const accountId = await createAccount();
        await disableAccount({ accountId, reason: "test", env: process.env });
        await expect(check(accountId)).resolves.toEqual({ ok: false, statusCode: 403, error: "account-disabled" });

        await db.repeatKey.delete({ where: { key: accountDisabledKey(accountId) } });

        await expect(check(accountId)).resolves.toEqual({ ok: true });
    });

    it("does not cache account-not-found, so an account created afterwards is accepted", async () => {
        const accountId = "acct-standing-cache-created-later";
        await expect(check(accountId)).resolves.toEqual({ ok: false, statusCode: 401, error: "invalid-token" });

        await db.account.create({ data: { id: accountId, publicKey: nextPublicKey() } });

        await expect(check(accountId)).resolves.toEqual({ ok: true });
    });

    it("applies a disable written by another process once the bound has passed", async () => {
        const accountId = await createAccount();
        await expect(check(accountId)).resolves.toEqual({ ok: true });

        // Another server process writes the marker; this process receives no invalidation.
        await db.repeatKey.create({
            data: {
                key: accountDisabledKey(accountId),
                value: "other-process",
                expiresAt: new Date(Date.now() + 3_600_000),
            },
        });
        await expect(check(accountId)).resolves.toEqual({ ok: true });

        advanceMonotonicClock(ACCOUNT_STANDING_CACHE_TTL_MS);
        await expect(check(accountId)).resolves.toEqual({ ok: false, statusCode: 403, error: "account-disabled" });
    });
});
