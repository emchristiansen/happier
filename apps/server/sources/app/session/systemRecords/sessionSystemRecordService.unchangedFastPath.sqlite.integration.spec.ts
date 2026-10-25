import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { upsertSessionSystemRecord, type UpsertSessionSystemRecordParams } from "./sessionSystemRecordService";

type InteractiveTransactionBoundary = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: unknown,
) => Promise<T>;

/**
 * Test-only wrapper at the real database boundary. "count" passes every transaction through;
 * "unavailable" fails every one the way an exhausted connection does (acquisition P2028).
 */
async function withTransactionBoundary<T>(
    mode: "count" | "unavailable",
    run: (boundary: Readonly<{ attempts: () => number }>) => Promise<T>,
): Promise<T> {
    const mutableDb = db as unknown as { $transaction: InteractiveTransactionBoundary };
    const original = mutableDb.$transaction;
    let attempts = 0;
    mutableDb.$transaction = async <R>(operation: (tx: Prisma.TransactionClient) => Promise<R>, options?: unknown) => {
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
    try {
        return await run({ attempts: () => attempts });
    } finally {
        mutableDb.$transaction = original;
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

describe("upsertSessionSystemRecord: unchanged records skip the transaction", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-system-record-fast-path-",
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

    async function createRecordParams(): Promise<UpsertSessionSystemRecordParams> {
        const account = await db.account.create({ data: { publicKey: `pk-ssr-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({
            data: {
                tag: `tag-ssr-${randomUUID()}`,
                accountId: account.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        return {
            actorUserId: account.id,
            sessionId: session.id,
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher-1" },
        };
    }

    it("answers an unchanged record from the stored row without opening a transaction", async () => {
        const params = await createRecordParams();
        const created = await upsertSessionSystemRecord(params);
        expect(created).toMatchObject({ ok: true, didCreate: true, didUpdate: false });
        if (!created.ok) return;

        const unchanged = await withTransactionBoundary("count", async (boundary) => {
            const result = await upsertSessionSystemRecord(params);
            expect(boundary.attempts()).toBe(0);
            return result;
        });
        expect(unchanged).toEqual({ ok: true, didCreate: false, didUpdate: false, record: created.record });
    });

    it("answers an unchanged record while transactions are unavailable", async () => {
        const params = await createRecordParams();
        const created = await upsertSessionSystemRecord(params);
        if (!created.ok) throw new Error("setup failed");

        const unchanged = await withTransactionBoundary("unavailable", async () => await upsertSessionSystemRecord(params));
        expect(unchanged).toEqual({ ok: true, didCreate: false, didUpdate: false, record: created.record });
    });

    it("still writes changed content through a transaction", async () => {
        const params = await createRecordParams();
        await upsertSessionSystemRecord(params);
        const changedParams = { ...params, content: { t: "encrypted" as const, c: "cipher-2" } };

        const updated = await withTransactionBoundary("count", async (boundary) => {
            const result = await upsertSessionSystemRecord(changedParams);
            expect(boundary.attempts()).toBe(1);
            return result;
        });
        expect(updated).toMatchObject({ ok: true, didCreate: false, didUpdate: true, record: { content: { t: "encrypted", c: "cipher-2" } } });

        await expect(withTransactionBoundary("unavailable", async () =>
            await upsertSessionSystemRecord({ ...params, content: { t: "encrypted", c: "cipher-3" } })))
            .resolves.toEqual({ ok: false, error: "internal" });
    });

    it("still writes changed content through the transaction when the optional read fails once", async () => {
        const params = await createRecordParams();
        await upsertSessionSystemRecord(params);
        const changedParams = { ...params, content: { t: "encrypted" as const, c: "cipher-after-stall" } };

        const updated = await withFirstRecordReadFailing("sessionSystemRecord", async (reads) =>
            await withTransactionBoundary("count", async (boundary) => {
                const result = await upsertSessionSystemRecord(changedParams);
                expect(reads.calls()).toBeGreaterThanOrEqual(1);
                expect(boundary.attempts()).toBe(1);
                return result;
            }));
        expect(updated).toMatchObject({ ok: true, didCreate: false, didUpdate: true, record: { content: { t: "encrypted", c: "cipher-after-stall" } } });
    });

    it("still answers an unchanged record through the transaction when the optional read fails once", async () => {
        const params = await createRecordParams();
        const created = await upsertSessionSystemRecord(params);
        if (!created.ok) throw new Error("setup failed");

        const unchanged = await withFirstRecordReadFailing("sessionSystemRecord", async () =>
            await withTransactionBoundary("count", async (boundary) => {
                const result = await upsertSessionSystemRecord(params);
                expect(boundary.attempts()).toBe(1);
                return result;
            }));
        expect(unchanged).toEqual({ ok: true, didCreate: false, didUpdate: false, record: created.record });
    });

    it("still answers a kind conflict through the transaction", async () => {
        const params = await createRecordParams();
        await upsertSessionSystemRecord(params);

        const conflict = await withTransactionBoundary("count", async (boundary) => {
            const result = await upsertSessionSystemRecord({ ...params, kind: "synopsis.v1" });
            expect(boundary.attempts()).toBe(1);
            return result;
        });
        expect(conflict).toEqual({ ok: false, error: "conflict" });
    });

    it("still creates a missing record through a transaction", async () => {
        const params = await createRecordParams();
        const created = await withTransactionBoundary("count", async (boundary) => {
            const result = await upsertSessionSystemRecord(params);
            expect(boundary.attempts()).toBe(1);
            return result;
        });
        expect(created).toMatchObject({ ok: true, didCreate: true, didUpdate: false });
    });
});
