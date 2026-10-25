import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { isTransactionAcquisitionUnavailableError } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recordUsageReportForAccount } from "./usageReportWriteService";

type InteractiveTransactionBoundary = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: unknown,
) => Promise<T>;

/**
 * Test-only wrapper at the real database boundary. "count" passes every transaction through;
 * "unavailable" fails every one the way an exhausted connection does (acquisition P2028).
 */
function installTransactionBoundary(mode: "count" | "unavailable"): Readonly<{ attempts: () => number; restore: () => void }> {
    const mutableDb = db as unknown as { $transaction: InteractiveTransactionBoundary };
    const original = mutableDb.$transaction;
    let attempts = 0;
    mutableDb.$transaction = async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown) => {
        attempts += 1;
        if (mode === "unavailable") {
            throw new Prisma.PrismaClientKnownRequestError(
                "Transaction API error: Unable to start a transaction in the given time.",
                {
                    code: "P2028",
                    clientVersion: Prisma.prismaVersion.client,
                    meta: { error: "Unable to start a transaction in the given time." },
                },
            );
        }
        return await original(operation, options);
    };
    return {
        attempts: () => attempts,
        restore: () => {
            mutableDb.$transaction = original;
        },
    };
}

async function withTransactionBoundary<T>(
    mode: "count" | "unavailable",
    run: (boundary: Readonly<{ attempts: () => number }>) => Promise<T>,
): Promise<T> {
    const boundary = installTransactionBoundary(mode);
    try {
        return await run(boundary);
    } finally {
        boundary.restore();
    }
}

/**
 * Test-only: the first `findUnique` on `model` through the global db fails with a retryable socket
 * timeout (P1008), as a transient SQLite stall would; later calls reach the real client.
 */
async function withFirstRecordReadFailing<T>(
    model: "usageReport" | "sessionSystemRecord",
    run: (reads: Readonly<{ calls: () => number }>) => Promise<T>,
): Promise<T> {
    const mutableDb = db as unknown as Record<string, object>;
    const original = mutableDb[model]!;
    let calls = 0;
    mutableDb[model] = new Proxy(original, {
        get: (target, prop) => {
            const value = Reflect.get(target, prop);
            if (prop !== "findUnique" || typeof value !== "function") {
                return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...args: unknown[]) => {
                calls += 1;
                if (calls === 1) {
                    throw new Prisma.PrismaClientKnownRequestError(
                        "Socket timeout (the database failed to respond to a query within the configured timeout).",
                        { code: "P1008", clientVersion: Prisma.prismaVersion.client, meta: {} },
                    );
                }
                return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            };
        },
    });
    try {
        return await run({ calls: () => calls });
    } finally {
        mutableDb[model] = original;
    }
}

const usage = (total: number) => ({
    tokens: { total, input: total - 1, output: 1 },
    cost: { total: total / 1000, input: 0, output: total / 1000 },
});

describe("recordUsageReportForAccount: unchanged reports skip the transaction", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-usage-fast-path-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        // One acquisition failure ends the transaction attempt immediately, so "unavailable" is quick.
        harness.resetEnv({ HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "1" });
    });

    async function createOwnedSession(): Promise<Readonly<{ userId: string; sessionId: string }>> {
        const account = await db.account.create({ data: { publicKey: `pk-usage-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({
            data: {
                tag: `tag-usage-${randomUUID()}`,
                accountId: account.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        return { userId: account.id, sessionId: session.id };
    }

    it("answers an unchanged session report from the stored row without opening a transaction", async () => {
        const { userId, sessionId } = await createOwnedSession();
        const first = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(10) });
        expect(first).toMatchObject({ ok: true, changed: true });
        if (!first.ok) return;

        const second = await withTransactionBoundary("count", async (boundary) => {
            const result = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(10) });
            expect(boundary.attempts()).toBe(0);
            return result;
        });
        expect(second).toEqual({ ok: true, changed: false, report: first.report, usageData: usage(10) });
    });

    it("answers an unchanged session report while transactions are unavailable", async () => {
        const { userId, sessionId } = await createOwnedSession();
        const first = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(11) });
        if (!first.ok) throw new Error("setup failed");

        const second = await withTransactionBoundary("unavailable", async () =>
            await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(11) }));
        expect(second).toEqual({ ok: true, changed: false, report: first.report, usageData: usage(11) });
    });

    it("still writes a changed session report through a transaction", async () => {
        const { userId, sessionId } = await createOwnedSession();
        await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(12) });

        const changed = await withTransactionBoundary("count", async (boundary) => {
            const result = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(13) });
            expect(boundary.attempts()).toBe(1);
            return result;
        });
        expect(changed).toMatchObject({ ok: true, changed: true, usageData: usage(13) });
        await expect(db.usageReport.findUnique({
            where: { accountId_sessionId_key: { accountId: userId, sessionId, key: "claude" } },
            select: { data: true },
        })).resolves.toEqual({ data: usage(13) });

        await expect(withTransactionBoundary("unavailable", async () =>
            await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(14) })))
            .rejects.toSatisfy(isTransactionAcquisitionUnavailableError);
    });

    it("still answers session-not-found through the transaction when the reporter does not own the session", async () => {
        const { userId: ownerId, sessionId } = await createOwnedSession();
        await recordUsageReportForAccount({ userId: ownerId, sessionId, key: "claude", ...usage(15) });
        const other = await db.account.create({ data: { publicKey: `pk-usage-other-${randomUUID()}` }, select: { id: true } });

        const result = await withTransactionBoundary("count", async (boundary) => {
            const value = await recordUsageReportForAccount({ userId: other.id, sessionId, key: "claude", ...usage(15) });
            expect(boundary.attempts()).toBe(1);
            return value;
        });
        expect(result).toEqual({ ok: false, error: "session-not-found" });
    });

    it("still answers session-not-found through the transaction after the session is deleted", async () => {
        const { userId, sessionId } = await createOwnedSession();
        await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(16) });
        // UsageReport.sessionId is ON DELETE SET NULL, so the row no longer names the session.
        await db.session.delete({ where: { id: sessionId } });

        const result = await withTransactionBoundary("count", async (boundary) => {
            const value = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(16) });
            expect(boundary.attempts()).toBe(1);
            return value;
        });
        expect(result).toEqual({ ok: false, error: "session-not-found" });
    });

    it("still writes a changed session report through the transaction when the optional read fails once", async () => {
        const { userId, sessionId } = await createOwnedSession();
        await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(40) });

        const changed = await withFirstRecordReadFailing("usageReport", async (reads) =>
            await withTransactionBoundary("count", async (boundary) => {
                const result = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(41) });
                expect(reads.calls()).toBeGreaterThanOrEqual(1);
                expect(boundary.attempts()).toBe(1);
                return result;
            }));
        expect(changed).toMatchObject({ ok: true, changed: true, usageData: usage(41) });
        await expect(db.usageReport.findUnique({
            where: { accountId_sessionId_key: { accountId: userId, sessionId, key: "claude" } },
            select: { data: true },
        })).resolves.toEqual({ data: usage(41) });
    });

    it("still answers an unchanged session report through the transaction when the optional read fails once", async () => {
        const { userId, sessionId } = await createOwnedSession();
        const first = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(42) });
        if (!first.ok) throw new Error("setup failed");

        const unchanged = await withFirstRecordReadFailing("usageReport", async () =>
            await withTransactionBoundary("count", async (boundary) => {
                const result = await recordUsageReportForAccount({ userId, sessionId, key: "claude", ...usage(42) });
                expect(boundary.attempts()).toBe(1);
                return result;
            }));
        expect(unchanged).toEqual({ ok: true, changed: false, report: first.report, usageData: usage(42) });
    });

    it("answers an unchanged account-level report without opening a transaction", async () => {
        const { userId } = await createOwnedSession();
        const first = await recordUsageReportForAccount({ userId, key: "account-total", ...usage(20) });
        if (!first.ok) throw new Error("setup failed");

        const second = await withTransactionBoundary("unavailable", async (boundary) => {
            const result = await recordUsageReportForAccount({ userId, key: "account-total", ...usage(20) });
            expect(boundary.attempts()).toBe(0);
            return result;
        });
        expect(second).toEqual({ ok: true, changed: false, report: first.report, usageData: usage(20) });
    });

    it("still removes duplicate account-level rows through a transaction even when the data is unchanged", async () => {
        const { userId } = await createOwnedSession();
        const older = await db.usageReport.create({
            data: { accountId: userId, sessionId: null, key: "account-dup", data: usage(30), updatedAt: new Date(1_000) },
            select: { id: true },
        });
        const newer = await db.usageReport.create({
            data: { accountId: userId, sessionId: null, key: "account-dup", data: usage(30), updatedAt: new Date(2_000) },
            select: { id: true },
        });

        const result = await withTransactionBoundary("count", async (boundary) => {
            const value = await recordUsageReportForAccount({ userId, key: "account-dup", ...usage(30) });
            expect(boundary.attempts()).toBe(1);
            return value;
        });
        expect(result).toMatchObject({ ok: true, changed: true, report: { id: newer.id } });
        await expect(db.usageReport.findMany({
            where: { accountId: userId, sessionId: null, key: "account-dup" },
            select: { id: true },
        })).resolves.toEqual([{ id: newer.id }]);
        expect(older.id).not.toBe(newer.id);
    });
});
