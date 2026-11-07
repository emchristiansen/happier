import { describe, expect, it, vi } from "vitest";
import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime";

import {
    prefixSqliteReadPoolPrometheusMetrics,
    renderSqliteReadPoolDatabaseUrl,
    requireSingleSqliteWriteConnection,
    resolveSqliteReadPoolConfigFromEnv,
    routeSqliteDbProperty,
    SQLITE_READ_POOL_MODEL_OPERATIONS,
    SQLITE_READ_POOL_PROMETHEUS_PREFIX,
} from "./sqliteReadPool";

describe("resolveSqliteReadPoolConfigFromEnv", () => {
    it("is disabled when unset or blank", () => {
        expect(resolveSqliteReadPoolConfigFromEnv({})).toEqual({ kind: "disabled" });
        expect(resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: "" })).toEqual({ kind: "disabled" });
        expect(resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: "  " })).toEqual({ kind: "disabled" });
    });

    it("accepts a whole number of connections from 1 to 64", () => {
        expect(resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: "1" })).toEqual({ kind: "enabled", connectionLimit: 1 });
        expect(resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: " 3 " })).toEqual({ kind: "enabled", connectionLimit: 3 });
        expect(resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: "64" })).toEqual({ kind: "enabled", connectionLimit: 64 });
    });

    it.each(["0", "65", "-1", "1.5", "3abc", "abc", "0x3"])("rejects %s", (raw) => {
        expect(() => resolveSqliteReadPoolConfigFromEnv({ HAPPIER_SQLITE_READ_POOL_SIZE: raw })).toThrow(/HAPPIER_SQLITE_READ_POOL_SIZE/);
    });
});

describe("renderSqliteReadPoolDatabaseUrl", () => {
    it("replaces only connection_limit and keeps every other parameter", () => {
        expect(renderSqliteReadPoolDatabaseUrl("file:/data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1", 3))
            .toBe("file:/data/happier-server-light.sqlite?socket_timeout=30&connection_limit=3");
        expect(renderSqliteReadPoolDatabaseUrl("file:/data/a b.sqlite?socket_timeout=7", 2))
            .toBe("file:/data/a b.sqlite?socket_timeout=7&connection_limit=2");
        expect(renderSqliteReadPoolDatabaseUrl("file:C:\\Users\\me\\data\\x.sqlite?connection_limit=1&socket_timeout=30", 4))
            .toBe("file:C:\\Users\\me\\data\\x.sqlite?connection_limit=4&socket_timeout=30");
    });
});

describe("native SQLite path and query composition", () => {
    it.each([
        "/data/hash#here/db.sqlite",
        "/data/literal%23#hash/db.sqlite",
        "C:\\Users\\hash#here\\db.sqlite",
    ])("validates and renders the canonical writer URL for %s", (dbPath) => {
        const writerUrl = renderPrismaCompatibleSqliteDatabaseUrl({
            dbPath, platform: process.platform, sqlite: { busyTimeoutMs: 30_000, connectionLimit: 1 },
        });
        expect(writerUrl).toBe(`file:${dbPath}?socket_timeout=30&connection_limit=1`);
        expect(() => requireSingleSqliteWriteConnection(writerUrl)).not.toThrow();
        expect(renderSqliteReadPoolDatabaseUrl(writerUrl, 2)).toBe(`file:${dbPath}?socket_timeout=30&connection_limit=2`);
    });

    it("preserves the literal hash path when replacing the read connection limit", () => {
        expect(renderSqliteReadPoolDatabaseUrl("file:/data/hash#here/db.sqlite?socket_timeout=30&connection_limit=1", 2))
            .toBe("file:/data/hash#here/db.sqlite?socket_timeout=30&connection_limit=2");
    });

    it.each([
        "file:/data/hash#here/db.sqlite?socket_timeout=30",
        "file:/data/hash#here/db.sqlite?connection_limit=2",
        "file:/data/hash#here/db.sqlite?connection_limit=1&connection_limit=1",
        "file:/data/hash#here/db.sqlite?connection_limit=1&connection_limit=4",
        "file:/data/hash#here/db.sqlite?connection_limit=4&connection_limit=1",
    ])("retains exactly-one writer enforcement for %s", (url) => {
        expect(() => requireSingleSqliteWriteConnection(url)).toThrow(/connection_limit=1/);
    });
});

describe("requireSingleSqliteWriteConnection", () => {
    it("accepts an explicit single write connection", () => {
        expect(() => requireSingleSqliteWriteConnection("file:/d/x.sqlite?socket_timeout=30&connection_limit=1")).not.toThrow();
    });

    it.each([
        "file:/d/x.sqlite?socket_timeout=30&connection_limit=4",
        "file:/d/x.sqlite?socket_timeout=30",
        "file:/d/x.sqlite",
        // Prisma honours the last of repeated parameters (measured: 1&4 opens 4 connections), so a
        // repeated connection_limit is refused whatever its values.
        "file:/d/x.sqlite?socket_timeout=30&connection_limit=1&connection_limit=4",
        "file:/d/x.sqlite?socket_timeout=30&connection_limit=4&connection_limit=1",
        "file:/d/x.sqlite?connection_limit=1&connection_limit=1",
    ])("refuses a read pool beside %s", (url) => {
        expect(() => requireSingleSqliteWriteConnection(url)).toThrow(/connection_limit=1/);
    });
});

function fakeClient(tag: "write" | "read") {
    const call = (name: string) => vi.fn(async () => `${tag}:${name}`);
    return {
        account: {
            findUnique: call("account.findUnique"),
            findUniqueOrThrow: call("account.findUniqueOrThrow"),
            findFirst: call("account.findFirst"),
            findFirstOrThrow: call("account.findFirstOrThrow"),
            findMany: call("account.findMany"),
            count: call("account.count"),
            aggregate: call("account.aggregate"),
            groupBy: call("account.groupBy"),
            create: call("account.create"),
            createMany: call("account.createMany"),
            update: call("account.update"),
            updateMany: call("account.updateMany"),
            upsert: call("account.upsert"),
            delete: call("account.delete"),
            deleteMany: call("account.deleteMany"),
            someFutureOperation: call("account.someFutureOperation"),
            fields: { id: `${tag}-field` },
        },
        $transaction: call("$transaction"),
        $queryRaw: call("$queryRaw"),
        $queryRawUnsafe: call("$queryRawUnsafe"),
        $executeRaw: call("$executeRaw"),
        $executeRawUnsafe: call("$executeRawUnsafe"),
        $connect: call("$connect"),
        $disconnect: call("$disconnect"),
        $metrics: {
            prometheus: vi.fn(async () => `# HELP prisma_pool_connections_open open\n# TYPE prisma_pool_connections_open gauge\nprisma_pool_connections_open ${tag === "write" ? 1 : 3}\n`),
            json: vi.fn(async () => ({
                counters: [{ key: "prisma_client_queries_total", labels: {}, value: tag === "write" ? 10 : 20, description: "" }],
                gauges: [{ key: "prisma_pool_connections_open", labels: {}, value: tag === "write" ? 1 : 3, description: "" }],
                histograms: [],
            })),
        },
    };
}

type FakeClient = ReturnType<typeof fakeClient>;

function callOperation(delegate: object, operation: string): Promise<unknown> {
    return (Reflect.get(delegate, operation) as () => Promise<unknown>)();
}

function routed(write: FakeClient, read: FakeClient | null): FakeClient {
    return new Proxy({} as FakeClient, {
        get: (_target, prop) => routeSqliteDbProperty({ write, read, prop }),
    });
}

describe("routeSqliteDbProperty", () => {
    it("allow-lists exactly the model read operations", () => {
        expect([...SQLITE_READ_POOL_MODEL_OPERATIONS].sort()).toEqual([
            "aggregate",
            "count",
            "findFirst",
            "findFirstOrThrow",
            "findMany",
            "findUnique",
            "findUniqueOrThrow",
            "groupBy",
        ]);
    });

    it("sends allow-listed model reads to the read client", async () => {
        const db = routed(fakeClient("write"), fakeClient("read"));
        for (const op of SQLITE_READ_POOL_MODEL_OPERATIONS) {
            await expect(callOperation(db.account, op)).resolves.toBe(`read:account.${op}`);
        }
    });

    it.each([
        "create",
        "createMany",
        "update",
        "updateMany",
        "upsert",
        "delete",
        "deleteMany",
        "someFutureOperation",
    ] as const)("sends non-listed model operation %s to the write client", async (op) => {
        const db = routed(fakeClient("write"), fakeClient("read"));
        await expect(db.account[op]()).resolves.toBe(`write:account.${op}`);
    });

    it.each([
        "$transaction",
        "$queryRaw",
        "$queryRawUnsafe",
        "$executeRaw",
        "$executeRawUnsafe",
    ] as const)("sends client operation %s, raw SQL included, to the write client", async (op) => {
        const db = routed(fakeClient("write"), fakeClient("read"));
        await expect(db[op]()).resolves.toBe(`write:${op}`);
    });

    it("hands out the write client's non-function model properties", () => {
        const db = routed(fakeClient("write"), fakeClient("read"));
        expect(db.account.fields).toEqual({ id: "write-field" });
    });

    it("connects and disconnects both clients", async () => {
        const write = fakeClient("write");
        const read = fakeClient("read");
        const db = routed(write, read);
        await db.$connect();
        await db.$disconnect();
        expect(write.$connect).toHaveBeenCalledTimes(1);
        expect(read.$connect).toHaveBeenCalledTimes(1);
        expect(write.$disconnect).toHaveBeenCalledTimes(1);
        expect(read.$disconnect).toHaveBeenCalledTimes(1);
    });

    it("sends everything to the write client when there is no read client", async () => {
        const db = routed(fakeClient("write"), null);
        for (const op of SQLITE_READ_POOL_MODEL_OPERATIONS) {
            await expect(callOperation(db.account, op)).resolves.toBe(`write:account.${op}`);
        }
        await expect(db.$metrics.prometheus()).resolves.not.toContain(SQLITE_READ_POOL_PROMETHEUS_PREFIX);
    });

    it("lets a test double replace a model method on the write client", async () => {
        const write = fakeClient("write");
        const db = routed(write, fakeClient("read"));
        const replacement = vi.fn(async () => "replaced");
        (db.account as Record<string, unknown>).create = replacement;
        expect(write.account.create).toBe(replacement);
    });

    it("adds the read pool's metrics under a prefix", async () => {
        const db = routed(fakeClient("write"), fakeClient("read"));
        const text = await db.$metrics.prometheus();
        expect(text).toContain("\nprisma_pool_connections_open 1\n");
        expect(text).toContain(`\n${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_pool_connections_open 3\n`);
        const json = await db.$metrics.json();
        expect(json.gauges).toEqual([
            expect.objectContaining({ key: "prisma_pool_connections_open", value: 1 }),
            expect.objectContaining({ key: `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_pool_connections_open`, value: 3 }),
        ]);
        expect(json.counters.map((c) => c.key)).toEqual([
            "prisma_client_queries_total",
            `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_client_queries_total`,
        ]);
    });
});

describe("prefixSqliteReadPoolPrometheusMetrics", () => {
    it("prefixes sample, HELP and TYPE lines and leaves blank lines alone", () => {
        expect(prefixSqliteReadPoolPrometheusMetrics([
            "# HELP prisma_client_queries_wait Number of queries waiting",
            "# TYPE prisma_client_queries_wait gauge",
            "prisma_client_queries_wait 2",
            "prisma_client_queries_wait_histogram_ms_bucket{le=\"0\"} 0",
            "",
        ].join("\n"))).toBe([
            `# HELP ${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_client_queries_wait Number of queries waiting`,
            `# TYPE ${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_client_queries_wait gauge`,
            `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_client_queries_wait 2`,
            `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}prisma_client_queries_wait_histogram_ms_bucket{le="0"} 0`,
            "",
        ].join("\n"));
    });
});
