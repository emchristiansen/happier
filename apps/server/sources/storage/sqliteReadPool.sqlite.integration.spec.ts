import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx, isTransactionDeadlineExceededError } from "./inTx";

// How long an operation that should not queue may take while a write transaction is held open.
const UNQUEUED_BUDGET_MS = 1_500;

type Settled<T> = Readonly<
    | { status: "fulfilled"; value: T; settledAtMs: number }
    | { status: "rejected"; reason: unknown; settledAtMs: number }
>;

function track<T>(promise: Promise<T>): Promise<Settled<T>> {
    return promise.then(
        (value) => ({ status: "fulfilled" as const, value, settledAtMs: Date.now() }),
        (reason: unknown) => ({ status: "rejected" as const, reason, settledAtMs: Date.now() }),
    );
}

async function settlesWithin<T>(promise: Promise<Settled<T>>, ms: number): Promise<Settled<T> | "pending"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Opens an inTx write transaction on `accountId`, sets its publicKey to `uncommittedPublicKey`,
 * reads it back through the transaction client, then holds the transaction open until released.
 */
async function holdWriteTransaction(params: Readonly<{ accountId: string; uncommittedPublicKey: string }>) {
    let opened!: (readBack: string | null) => void;
    const openedPromise = new Promise<string | null>((resolve) => {
        opened = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let releasedAtMs: number | null = null;
    const done = inTx(async (tx) => {
        await tx.account.update({ where: { id: params.accountId }, data: { publicKey: params.uncommittedPublicKey } });
        const readBack = await tx.account.findUnique({ where: { id: params.accountId }, select: { publicKey: true } });
        opened(readBack?.publicKey ?? null);
        await released;
        return "committed";
    });
    const readBack = await openedPromise;
    return {
        readBack,
        release: () => {
            releasedAtMs = Date.now();
            release();
        },
        releasedAtMs: () => releasedAtMs,
        done,
    };
}

async function createAccount(): Promise<Readonly<{ id: string; publicKey: string }>> {
    const publicKey = `pk-read-pool-${randomUUID()}`;
    const account = await db.account.create({ data: { publicKey }, select: { id: true } });
    return { id: account.id, publicKey };
}

function expectDeadlineExceeded(result: Settled<unknown>, deadlineAtMs: number): void {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(isTransactionDeadlineExceededError(result.reason)).toBe(true);
    expect(result.settledAtMs).toBeLessThanOrEqual(deadlineAtMs + 500);
}

describe("SQLite read pool: one write connection plus a read pool of 3 (4 connections)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-read-pool-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: { HAPPIER_SQLITE_READ_POOL_SIZE: "3" },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("keeps a transaction's own reads on its client, so they see its uncommitted write", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        try {
            expect(held.readBack).toBe(`${account.publicKey}-uncommitted`);
        } finally {
            held.release();
            await held.done;
        }
    });

    it("answers a plain read beside a held write transaction and a waiting writer, from the last committed state", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        const waitingWriter = track(inTx(async (tx) => await tx.account.count()));
        try {
            const read = await settlesWithin(
                track(db.account.findUnique({ where: { id: account.id }, select: { publicKey: true } })),
                UNQUEUED_BUDGET_MS,
            );
            expect(read).not.toBe("pending");
            expect(held.releasedAtMs()).toBeNull();
            expect(read).toMatchObject({ status: "fulfilled", value: { publicKey: account.publicKey } });
        } finally {
            held.release();
            await held.done;
            await waitingWriter;
        }
        await expect(db.account.findUnique({ where: { id: account.id }, select: { publicKey: true } }))
            .resolves.toEqual({ publicKey: `${account.publicKey}-uncommitted` });
    });

    it("fails a deadline-bounded inTx cleanly before its deadline while the write connection is held", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        const deadlineAtMs = Date.now() + 1_000;
        let callbackEntered = false;
        try {
            const result = await track(inTx(async (tx) => {
                callbackEntered = true;
                await tx.account.update({ where: { id: account.id }, data: { publicKey: `${account.publicKey}-late` } });
                return "late";
            }, { deadlineAtMs }));
            expect(held.releasedAtMs()).toBeNull();
            expectDeadlineExceeded(result, deadlineAtMs);
            expect(callbackEntered).toBe(false);
        } finally {
            held.release();
            await held.done;
        }
        await expect(db.account.findUnique({ where: { id: account.id }, select: { publicKey: true } }))
            .resolves.toEqual({ publicKey: `${account.publicKey}-uncommitted` });
    });

    it("keeps operations that are not on the read allow-list, raw SQL included, on the write connection", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        const rawRead = track(db.$queryRawUnsafe<Array<{ one: number | bigint }>>("SELECT 1 AS one"));
        const modelWrite = track(db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } }));
        try {
            expect(await settlesWithin(rawRead, UNQUEUED_BUDGET_MS)).toBe("pending");
            expect(await settlesWithin(modelWrite, 1)).toBe("pending");
        } finally {
            held.release();
            await held.done;
        }
        const releasedAtMs = held.releasedAtMs();
        expect(releasedAtMs).not.toBeNull();
        const raw = await rawRead;
        const write = await modelWrite;
        expect(raw.status).toBe("fulfilled");
        expect(write.status).toBe("fulfilled");
        expect(raw.settledAtMs).toBeGreaterThanOrEqual(releasedAtMs!);
        expect(write.settledAtMs).toBeGreaterThanOrEqual(releasedAtMs!);
    });

    it("adds the read pool's Prisma metrics to db.$metrics under a prefix", async () => {
        await db.account.count();
        const text = await db.$metrics.prometheus();
        expect(text).toMatch(/^prisma_pool_connections_open \d+$/m);
        expect(text).toMatch(/^happier_sqlite_read_pool_prisma_pool_connections_open \d+$/m);
        expect(text).toMatch(/^# TYPE happier_sqlite_read_pool_prisma_client_queries_total counter$/m);
        const json = await db.$metrics.json();
        expect(json.gauges.map((gauge) => gauge.key)).toEqual(expect.arrayContaining([
            "prisma_pool_connections_open",
            "happier_sqlite_read_pool_prisma_pool_connections_open",
        ]));
    });
});

describe("SQLite without a read pool (shipped default): behaviour unchanged", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-no-read-pool-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("keeps a transaction's own reads on its client, so they see its uncommitted write", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        try {
            expect(held.readBack).toBe(`${account.publicKey}-uncommitted`);
        } finally {
            held.release();
            await held.done;
        }
    });

    it("queues a plain read behind a held write transaction and answers it from the committed write", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        const read = track(db.account.findUnique({ where: { id: account.id }, select: { publicKey: true } }));
        try {
            expect(await settlesWithin(read, UNQUEUED_BUDGET_MS)).toBe("pending");
        } finally {
            held.release();
            await held.done;
        }
        const settled = await read;
        expect(settled).toMatchObject({ status: "fulfilled", value: { publicKey: `${account.publicKey}-uncommitted` } });
        expect(settled.settledAtMs).toBeGreaterThanOrEqual(held.releasedAtMs()!);
    });

    it("fails a deadline-bounded inTx cleanly before its deadline while the connection is held", async () => {
        const account = await createAccount();
        const held = await holdWriteTransaction({ accountId: account.id, uncommittedPublicKey: `${account.publicKey}-uncommitted` });
        const deadlineAtMs = Date.now() + 1_000;
        let callbackEntered = false;
        try {
            const result = await track(inTx(async (tx) => {
                callbackEntered = true;
                await tx.account.update({ where: { id: account.id }, data: { publicKey: `${account.publicKey}-late` } });
                return "late";
            }, { deadlineAtMs }));
            expect(held.releasedAtMs()).toBeNull();
            expectDeadlineExceeded(result, deadlineAtMs);
            expect(callbackEntered).toBe(false);
        } finally {
            held.release();
            await held.done;
        }
    });

    it("reports Prisma metrics without read-pool series", async () => {
        const text = await db.$metrics.prometheus();
        expect(text).toMatch(/^prisma_pool_connections_open \d+$/m);
        expect(text).not.toContain("happier_sqlite_read_pool_");
    });
});


describe("SQLite read-pool startup with a native hash filename", () => {
    it("initializes both clients on the same physical database", async () => {
        const harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-read-pool-hash#-",
            initAuth: false, initEncrypt: false, initFiles: false,
            env: { HAPPIER_SQLITE_READ_POOL_SIZE: "2" },
        });
        try {
            expect(harness.dbPath).toContain("hash#");
            const account = await createAccount();
            await expect(db.account.findUnique({ where: { id: account.id }, select: { publicKey: true } }))
                .resolves.toEqual({ publicKey: account.publicKey });
            const databases = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list");
            expect(databases.find((database) => database.name === "main")?.file).toBe(harness.dbPath);
            expect(await db.$metrics.prometheus()).toContain("happier_sqlite_read_pool_prisma_pool_connections_open");
        } finally {
            await harness.close();
        }
    }, 120_000);
});
