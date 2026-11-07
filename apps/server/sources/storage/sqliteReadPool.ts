/**
 * Optional SQLite read pool beside the single write connection.
 *
 * With one Prisma connection (the server-light default), every statement shares that connection, so
 * a plain read waits behind any open interactive transaction. Raising the connection limit of the one
 * client does not fix that safely: Prisma opens SQLite interactive transactions with BEGIN IMMEDIATE,
 * so a second transaction then waits for the write lock inside SQLite's busy handler, where neither
 * `maxWait`, the transaction `timeout` nor an inTx deadline bounds the wait. Per-connection PRAGMAs
 * (`synchronous`, `journal_size_limit`) would also reach only one pooled connection.
 *
 * Instead, the write client keeps exactly one connection, and so keeps today's queueing, `maxWait`
 * / P2028 acquisition errors and deadline arithmetic for every write. A second client, created only
 * when HAPPIER_SQLITE_READ_POOL_SIZE is set, serves the allow-listed model read operations issued
 * outside a transaction. Anything not on the allow-list (writes, raw SQL, `$transaction`, and every
 * operation on a transaction client) stays on the write connection.
 */

import { readPrismaSqliteConnectionParams } from "@happier-dev/cli-common/firstPartyRuntime";

export const SQLITE_READ_POOL_SIZE_ENV = "HAPPIER_SQLITE_READ_POOL_SIZE";
const SQLITE_READ_POOL_SIZE_MAX = 64;

export type SqliteReadPoolConfig =
    | Readonly<{ kind: "disabled" }>
    | Readonly<{ kind: "enabled"; connectionLimit: number }>;

export function resolveSqliteReadPoolConfigFromEnv(env: NodeJS.ProcessEnv): SqliteReadPoolConfig {
    const raw = String(env[SQLITE_READ_POOL_SIZE_ENV] ?? "").trim();
    if (!raw) return { kind: "disabled" };
    const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SQLITE_READ_POOL_SIZE_MAX) {
        throw new Error(
            `Invalid ${SQLITE_READ_POOL_SIZE_ENV}: ${raw} (expected a whole number of read connections from 1 to ${SQLITE_READ_POOL_SIZE_MAX}, or unset for no read pool)`,
        );
    }
    return { kind: "enabled", connectionLimit: parsed };
}

type SplitDatabaseUrl = Readonly<{ base: string; searchParams: URLSearchParams }>;

function splitDatabaseUrl(databaseUrl: string): SplitDatabaseUrl {
    // Prisma consumes the file payload as a native path, including literal hashes.
    const queryIndex = databaseUrl.indexOf("?");
    return {
        base: queryIndex >= 0 ? databaseUrl.slice(0, queryIndex) : databaseUrl,
        searchParams: readPrismaSqliteConnectionParams(databaseUrl),
    };
}

/** The read client's URL: the write URL with only `connection_limit` replaced. */
export function renderSqliteReadPoolDatabaseUrl(databaseUrl: string, connectionLimit: number): string {
    const { base, searchParams } = splitDatabaseUrl(databaseUrl);
    searchParams.set("connection_limit", String(connectionLimit));
    return `${base}?${searchParams.toString()}`;
}

/**
 * A read pool is only sound beside exactly one write connection; refuse anything else at startup.
 * Prisma honours the last of repeated URL parameters while URLSearchParams.get returns the first, so
 * the URL must carry exactly one connection_limit, and it must be 1.
 */
export function requireSingleSqliteWriteConnection(databaseUrl: string): void {
    const found = splitDatabaseUrl(databaseUrl).searchParams.getAll("connection_limit");
    if (found.length !== 1 || found[0]!.trim() !== "1") {
        const described = found.length === 0
            ? "no connection_limit"
            : found.map((value) => `connection_limit=${value}`).join(" and ");
        throw new Error(
            `${SQLITE_READ_POOL_SIZE_ENV} requires DATABASE_URL to set exactly one connection_limit=1 for the write connection (found: ${described})`,
        );
    }
}

/** Model operations that only read. Everything else goes to the write connection. */
export const SQLITE_READ_POOL_MODEL_OPERATIONS: ReadonlySet<string> = new Set([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
]);

export const SQLITE_READ_POOL_PROMETHEUS_PREFIX = "happier_sqlite_read_pool_";

/** Renames every series in a Prometheus text exposition so read-pool metrics cannot collide. */
export function prefixSqliteReadPoolPrometheusMetrics(text: string): string {
    return text
        .split("\n")
        .map((line) => {
            const comment = /^# (HELP|TYPE) /.exec(line);
            if (comment) return `${comment[0]}${SQLITE_READ_POOL_PROMETHEUS_PREFIX}${line.slice(comment[0].length)}`;
            if (line.trim() === "" || line.startsWith("#")) return line;
            return `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}${line}`;
        })
        .join("\n");
}

type PrismaMetric = Readonly<{ key: string }>;
type PrismaMetricsJson = Readonly<{
    counters: readonly PrismaMetric[];
    gauges: readonly PrismaMetric[];
    histograms: readonly PrismaMetric[];
}>;
type PrismaMetricsApi = Readonly<{
    json: (options?: unknown) => Promise<PrismaMetricsJson>;
    prometheus: (options?: unknown) => Promise<string>;
}>;

function prefixMetricKeys<T extends PrismaMetric>(metrics: readonly T[]): T[] {
    return metrics.map((metric) => ({ ...metric, key: `${SQLITE_READ_POOL_PROMETHEUS_PREFIX}${metric.key}` }));
}

function combineMetrics(write: PrismaMetricsApi, read: PrismaMetricsApi): PrismaMetricsApi {
    return {
        json: async (options?: unknown) => {
            const [writeMetrics, readMetrics] = await Promise.all([write.json(options), read.json(options)]);
            return {
                counters: [...writeMetrics.counters, ...prefixMetricKeys(readMetrics.counters)],
                gauges: [...writeMetrics.gauges, ...prefixMetricKeys(readMetrics.gauges)],
                histograms: [...writeMetrics.histograms, ...prefixMetricKeys(readMetrics.histograms)],
            };
        },
        prometheus: async (options?: unknown) => {
            const [writeText, readText] = await Promise.all([write.prometheus(options), read.prometheus(options)]);
            const separator = writeText === "" || writeText.endsWith("\n") ? "" : "\n";
            return `${writeText}${separator}${prefixSqliteReadPoolPrometheusMetrics(readText)}`;
        },
    };
}

function bindIfFunction(value: unknown, owner: object): unknown {
    return typeof value === "function" ? value.bind(owner) : value;
}

function isModelDelegateProperty(prop: string | symbol, value: unknown): prop is string {
    return typeof prop === "string"
        && !prop.startsWith("$")
        && !prop.startsWith("_")
        && value !== null
        && typeof value === "object";
}

function routeModelDelegate(writeDelegate: object, readDelegate: object): object {
    // A plain target, so the traps below decide every lookup; assignments (test doubles) land on the
    // write client's delegate, exactly as they did before the read pool existed.
    return new Proxy({}, {
        get: (_target, operation) => {
            if (typeof operation === "string" && SQLITE_READ_POOL_MODEL_OPERATIONS.has(operation)) {
                return bindIfFunction(Reflect.get(readDelegate, operation), readDelegate);
            }
            return bindIfFunction(Reflect.get(writeDelegate, operation), writeDelegate);
        },
        set: (_target, operation, value) => Reflect.set(writeDelegate, operation, value),
    });
}

const routedDelegateCache = new WeakMap<object, Readonly<{ readDelegate: object; routed: object }>>();

async function runOnBoth(write: object, read: object, method: "$connect" | "$disconnect"): Promise<void> {
    const results = await Promise.allSettled([
        (Reflect.get(write, method) as () => Promise<void>).call(write),
        (Reflect.get(read, method) as () => Promise<void>).call(read),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
}

/**
 * What the `db` proxy hands out for `prop`. Without a read client this is the write client's own
 * property (functions bound), which is the behaviour before the read pool existed.
 */
export function routeSqliteDbProperty(params: Readonly<{
    write: object;
    read: object | null;
    prop: string | symbol;
}>): unknown {
    const { write, read, prop } = params;
    const value = Reflect.get(write, prop);
    if (read === null) return bindIfFunction(value, write);

    if (prop === "$connect" || prop === "$disconnect") {
        return async () => await runOnBoth(write, read, prop);
    }
    if (prop === "$metrics") {
        return combineMetrics(value as PrismaMetricsApi, Reflect.get(read, prop) as PrismaMetricsApi);
    }
    if (isModelDelegateProperty(prop, value)) {
        const readDelegate = Reflect.get(read, prop);
        if (readDelegate === null || typeof readDelegate !== "object") return value;
        const cached = routedDelegateCache.get(value);
        if (cached !== undefined && cached.readDelegate === readDelegate) return cached.routed;
        const routed = routeModelDelegate(value, readDelegate);
        routedDelegateCache.set(value, { readDelegate, routed });
        return routed;
    }
    return bindIfFunction(value, write);
}
