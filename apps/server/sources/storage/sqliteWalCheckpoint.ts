import type { PrismaClientType } from "@/storage/prisma";
import { sqliteMaintenanceDurationHistogram } from "@/app/monitoring/metrics2";
import { log } from "@/utils/logging/log";

// Active WAL checkpoint cadence for the light/sqlite server.
//
// Passive autocheckpoint can be starved indefinitely by long-lived / overlapping
// read transactions (e.g. session-message subscriptions). When that happens the
// WAL grows without bound, every read slows down as it scans WAL frames, and writes
// can eventually exceed Prisma's query timeout and surface as `Socket timeout`
// errors. The maintenance loop first advances the WAL with a non-blocking PASSIVE
// checkpoint. It requests a bounded TRUNCATE wait only when PASSIVE leaves a real
// uncheckpointed backlog; a reset-only wait can otherwise block the sole primary
// SQLite connection without making any additional frame progress.
const DEFAULT_WAL_CHECKPOINT_INTERVAL_MS = 60_000;
const DEFAULT_WAL_CHECKPOINT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_INCREMENTAL_VACUUM_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INCREMENTAL_VACUUM_PAGES = 1_000;

// `setInterval` stores its delay in a 32-bit signed int. A larger value is silently
// coerced to 1ms (with a TimeoutOverflowWarning), which would turn this into a hot loop.
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;
// SQLite's busy timeout API also takes a signed 32-bit millisecond value.
const MAX_SQLITE_BUSY_TIMEOUT_MS = 2_147_483_647;
const MAX_SQLITE_INCREMENTAL_VACUUM_PAGES = 2_147_483_647;

export type SqliteWalCheckpointResult = Readonly<{
    // SQLite returns 1 when the checkpoint could not run to completion because the
    // database was busy (e.g. a reader held the WAL), 0 otherwise.
    busy: number;
    // Number of frames in the WAL file.
    logFrames: number;
    // Total number of WAL frames that have been checkpointed, including frames
    // checkpointed before this invocation.
    checkpointedFrames: number;
}>;

function parseUnsignedIntegerEnv(params: Readonly<{
    env: NodeJS.ProcessEnv;
    primaryKey: string;
    legacyKey?: string;
    defaultValue: number;
    maxValue: number;
    allowZero: boolean;
}>): number {
    const raw = String(
        params.env[params.primaryKey] ?? (params.legacyKey ? params.env[params.legacyKey] : undefined) ?? "",
    ).trim();
    if (!raw) return params.defaultValue;
    if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid ${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""}: ${raw}`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || (!params.allowZero && parsed < 1)) {
        throw new Error(`Invalid ${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""}: ${raw}`);
    }
    if (parsed > params.maxValue) {
        throw new Error(
            `${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""} must be <= ${params.maxValue}: ${raw}`,
        );
    }
    return parsed;
}

/**
 * Resolve the interval (ms) between active WAL checkpoints.
 *
 * Env: `HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS` / `HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS`
 *  - unset            -> default (60s)
 *  - "0"              -> disabled
 *  - positive integer -> that many ms
 */
export function resolveSqliteWalCheckpointIntervalMsFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS",
        legacyKey: "HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS",
        defaultValue: DEFAULT_WAL_CHECKPOINT_INTERVAL_MS,
        maxValue: MAX_TIMER_INTERVAL_MS,
        allowZero: true,
    });
}

/**
 * Resolve how long a TRUNCATE checkpoint may wait for reader/writer gaps.
 *
 * Env: `HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS` / `HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS`
 *  - unset            -> default (5s)
 *  - "0"              -> opportunistic only
 *  - positive integer -> that many ms
 */
export function resolveSqliteWalCheckpointBusyTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS",
        legacyKey: "HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS",
        defaultValue: DEFAULT_WAL_CHECKPOINT_BUSY_TIMEOUT_MS,
        maxValue: MAX_SQLITE_BUSY_TIMEOUT_MS,
        allowZero: true,
    });
}

/**
 * Resolve the interval (ms) between incremental SQLite vacuum batches.
 *
 * Env: `HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS` / `HAPPY_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS`
 *  - unset            -> default (6h)
 *  - "0"              -> disabled
 *  - positive integer -> that many ms
 */
export function resolveSqliteIncrementalVacuumIntervalMsFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS",
        legacyKey: "HAPPY_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS",
        defaultValue: DEFAULT_INCREMENTAL_VACUUM_INTERVAL_MS,
        maxValue: MAX_TIMER_INTERVAL_MS,
        allowZero: true,
    });
}

/**
 * Resolve how many free pages one incremental vacuum batch may reclaim.
 *
 * Env: `HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES` / `HAPPY_SQLITE_INCREMENTAL_VACUUM_PAGES`
 *  - unset            -> default (1000 pages)
 *  - positive integer -> that many pages per batch
 */
export function resolveSqliteIncrementalVacuumPagesFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES",
        legacyKey: "HAPPY_SQLITE_INCREMENTAL_VACUUM_PAGES",
        defaultValue: DEFAULT_INCREMENTAL_VACUUM_PAGES,
        maxValue: MAX_SQLITE_INCREMENTAL_VACUUM_PAGES,
        allowZero: false,
    });
}

async function runSqliteWalCheckpoint(
    client: PrismaClientType,
    mode: "PASSIVE" | "TRUNCATE",
): Promise<SqliteWalCheckpointResult> {
    // `PRAGMA wal_checkpoint` returns three integer columns documented as
    // (busy, log, checkpointed). Prefer SQLite's documented column names, falling back
    // to positional order, so we are robust to driver-specific result shaping either way.
    const rows = await client.$queryRawUnsafe<Array<Record<string, number | bigint>>>(
        `PRAGMA wal_checkpoint(${mode});`,
    );
    const row = rows[0] ?? {};
    const positional = Object.values(row);
    const read = (name: string, index: number): number => Number(row[name] ?? positional[index] ?? 0);
    return {
        busy: read("busy", 0),
        logFrames: read("log", 1),
        checkpointedFrames: read("checkpointed", 2),
    };
}

/**
 * Run a single TRUNCATE checkpoint, resetting the WAL file to zero bytes when it can.
 * Returns SQLite's `(busy, log, checkpointed)` triple.
 */
export async function checkpointSqliteWal(client: PrismaClientType): Promise<SqliteWalCheckpointResult> {
    return runSqliteWalCheckpoint(client, "TRUNCATE");
}

/**
 * Advance WAL frames without invoking SQLite's busy handler first. A blocking reset
 * is useful only when PASSIVE could not checkpoint every frame; when all frames are
 * already checkpointed, SQLite can recycle the WAL after the reader gap on its own.
 */
export async function maintainSqliteWal(client: PrismaClientType): Promise<SqliteWalCheckpointResult> {
    const passive = await runSqliteWalCheckpoint(client, "PASSIVE");
    if (passive.logFrames <= passive.checkpointedFrames) {
        return passive;
    }
    return checkpointSqliteWal(client);
}

export type SqliteWalCheckpointWorkerHandle = Readonly<{ stop: () => Promise<void> }>;
export type SqliteIncrementalVacuumWorkerHandle = Readonly<{ stop: () => Promise<void> }>;

export type StartSqliteWalCheckpointWorkerOptions = Readonly<{
    client: PrismaClientType;
    intervalMs: number;
    // Injectable for tests; defaults to PASSIVE-first maintenance with TRUNCATE only for backlog.
    runCheckpoint?: (client: PrismaClientType) => Promise<SqliteWalCheckpointResult>;
}>;

/**
 * Start a background worker that periodically runs PASSIVE-first WAL maintenance.
 *
 * Returns `null` when checkpointing is disabled (`intervalMs <= 0`). The returned
 * handle's `stop()` clears the timer and awaits any in-flight checkpoint so it is
 * safe to call during shutdown even though shutdown handlers run concurrently.
 */
export function startSqliteWalCheckpointWorker(
    options: StartSqliteWalCheckpointWorkerOptions,
): SqliteWalCheckpointWorkerHandle | null {
    if (options.intervalMs <= 0) {
        return null;
    }
    const runCheckpoint = options.runCheckpoint ?? maintainSqliteWal;

    let stopped = false;
    let inFlight: Promise<void> | null = null;
    let consecutiveBusyCount = 0;

    const run = async (): Promise<void> => {
        if (stopped || inFlight) return;
        inFlight = (async () => {
            const startedAtMs = Date.now();
            let outcome = "error";
            try {
                const result = await runCheckpoint(options.client);
                if (result.busy !== 0) {
                    consecutiveBusyCount += 1;
                    outcome = result.logFrames > 0 && result.logFrames === result.checkpointedFrames
                        ? "wal-reset-deferred"
                        : "checkpoint-incomplete";
                    log(
                        {
                            module: "storage",
                            event: "sqlite-wal-checkpoint-busy",
                            sqliteWalCheckpoint: {
                                ...result,
                                outcome,
                                durationMs: Date.now() - startedAtMs,
                                retryIntervalMs: options.intervalMs,
                                consecutiveBusyCount,
                            },
                        },
                        outcome === "wal-reset-deferred"
                            ? "SQLite WAL frames were checkpointed, but the WAL reset was deferred because the database is busy; retry scheduled"
                            : "SQLite WAL checkpoint was incomplete because the database is busy; retry scheduled",
                    );
                } else {
                    consecutiveBusyCount = 0;
                    outcome = "ok";
                }
            } catch (error) {
                consecutiveBusyCount = 0;
                log(
                    { module: "storage", event: "sqlite-wal-checkpoint-failed", error },
                    "SQLite WAL checkpoint failed",
                );
            } finally {
                sqliteMaintenanceDurationHistogram.observe(
                    { operation: "wal_checkpoint", outcome },
                    (Date.now() - startedAtMs) / 1_000,
                );
                inFlight = null;
            }
        })();
    };

    const timer = setInterval(() => {
        void run();
    }, options.intervalMs);
    timer.unref?.();

    return {
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            if (inFlight) {
                await inFlight;
            }
        },
    };
}

/**
 * Run one bounded SQLite incremental vacuum batch.
 *
 * This is intentionally not `VACUUM`: full VACUUM rewrites the database and can
 * block writers for too long on light-server installs. `incremental_vacuum(N)`
 * reclaims at most N free pages when the database was created with incremental
 * auto-vacuum, and is otherwise a harmless no-op.
 */
export async function incrementalVacuumSqlite(client: PrismaClientType, pages: number): Promise<void> {
    const normalizedPages = parseUnsignedIntegerEnv({
        env: { HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: String(pages) },
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES",
        defaultValue: DEFAULT_INCREMENTAL_VACUUM_PAGES,
        maxValue: MAX_SQLITE_INCREMENTAL_VACUUM_PAGES,
        allowZero: false,
    });
    await client.$executeRawUnsafe(`PRAGMA incremental_vacuum(${normalizedPages});`);
}

export type StartSqliteIncrementalVacuumWorkerOptions = Readonly<{
    client: PrismaClientType;
    intervalMs: number;
    pages: number;
    // Injectable for tests; defaults to a real incremental vacuum batch.
    runVacuum?: (client: PrismaClientType, pages: number) => Promise<void>;
}>;

export function startSqliteIncrementalVacuumWorker(
    options: StartSqliteIncrementalVacuumWorkerOptions,
): SqliteIncrementalVacuumWorkerHandle | null {
    if (options.intervalMs <= 0) {
        return null;
    }
    const runVacuum = options.runVacuum ?? incrementalVacuumSqlite;

    let stopped = false;
    let inFlight: Promise<void> | null = null;

    const run = async (): Promise<void> => {
        if (stopped || inFlight) return;
        inFlight = (async () => {
            const startedAtMs = Date.now();
            let outcome = "error";
            try {
                await runVacuum(options.client, options.pages);
                outcome = "ok";
            } catch (error) {
                log(
                    { module: "storage", event: "sqlite-incremental-vacuum-failed", error },
                    "SQLite incremental vacuum failed",
                );
            } finally {
                sqliteMaintenanceDurationHistogram.observe(
                    { operation: "incremental_vacuum", outcome },
                    (Date.now() - startedAtMs) / 1_000,
                );
                inFlight = null;
            }
        })();
    };

    const timer = setInterval(() => {
        void run();
    }, options.intervalMs);
    timer.unref?.();

    return {
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            if (inFlight) {
                await inFlight;
            }
        },
    };
}
