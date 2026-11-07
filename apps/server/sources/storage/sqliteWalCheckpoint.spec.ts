import { afterEach, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => ({ log: vi.fn() }));
const monitoringMocks = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock("@/utils/logging/log", () => loggingMocks);
vi.mock("@/app/monitoring/metrics2", () => ({
    sqliteMaintenanceDurationHistogram: { observe: monitoringMocks.observe },
}));

import type { PrismaClientType } from "@/storage/prisma";
import {
    checkpointSqliteWal,
    maintainSqliteWal,
    incrementalVacuumSqlite,
    resolveSqliteIncrementalVacuumIntervalMsFromEnv,
    resolveSqliteIncrementalVacuumPagesFromEnv,
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv,
    resolveSqliteWalCheckpointIntervalMsFromEnv,
    startSqliteIncrementalVacuumWorker,
    startSqliteWalCheckpointWorker,
    type SqliteWalCheckpointResult,
} from "@/storage/sqliteWalCheckpoint";

// The worker only forwards this to the injected runCheckpoint, so a sentinel is enough.
const client = {} as unknown as PrismaClientType;
const ok: SqliteWalCheckpointResult = { busy: 0, logFrames: 0, checkpointedFrames: 0 };

describe("resolveSqliteWalCheckpointIntervalMsFromEnv", () => {
    it("defaults to 60s when unset", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({})).toBe(60_000);
    });

    it("treats 0 as disabled", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "0" })).toBe(0);
    });

    it("reads an explicit interval and the HAPPY_ alias", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "5000" })).toBe(5000);
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "1500" })).toBe(1500);
    });

    it("rejects non-numeric values", () => {
        expect(() => resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "soon" })).toThrow();
    });

    it("rejects values that are not safe integers", () => {
        expect(() =>
            resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "99999999999999999999" }),
        ).toThrow();
    });

    it("rejects intervals beyond the 32-bit setInterval bound", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "2147483647" })).toBe(
            2_147_483_647,
        );
        expect(() =>
            resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "2147483648" }),
        ).toThrow();
    });
});

describe("resolveSqliteWalCheckpointBusyTimeoutMsFromEnv", () => {
    it("defaults to a bounded wait for reader gaps", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({})).toBe(5_000);
    });

    it("reads an explicit timeout and the HAPPY_ alias", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "2500",
        })).toBe(2500);
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "1500",
        })).toBe(1500);
    });

    it("allows 0 for an explicitly opportunistic checkpoint", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "0",
        })).toBe(0);
    });

    it("rejects invalid or unsafe timeout values", () => {
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "soon",
            }),
        ).toThrow();
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "99999999999999999999",
            }),
        ).toThrow();
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "2147483648",
            }),
        ).toThrow();
    });
});

describe("resolveSqliteIncrementalVacuumIntervalMsFromEnv", () => {
    it("defaults to a low-frequency maintenance cadence", () => {
        expect(resolveSqliteIncrementalVacuumIntervalMsFromEnv({})).toBe(6 * 60 * 60 * 1000);
    });

    it("treats 0 as disabled and accepts the HAPPY_ alias", () => {
        expect(resolveSqliteIncrementalVacuumIntervalMsFromEnv({
            HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: "0",
        })).toBe(0);
        expect(resolveSqliteIncrementalVacuumIntervalMsFromEnv({
            HAPPY_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: "1500",
        })).toBe(1500);
    });
});

describe("resolveSqliteIncrementalVacuumPagesFromEnv", () => {
    it("defaults to bounded page batches", () => {
        expect(resolveSqliteIncrementalVacuumPagesFromEnv({})).toBe(1_000);
    });

    it("rejects zero, invalid, and unsafe page counts", () => {
        expect(() => resolveSqliteIncrementalVacuumPagesFromEnv({
            HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: "0",
        })).toThrow();
        expect(() => resolveSqliteIncrementalVacuumPagesFromEnv({
            HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: "soon",
        })).toThrow();
        expect(() => resolveSqliteIncrementalVacuumPagesFromEnv({
            HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: "99999999999999999999",
        })).toThrow();
    });
});

describe("checkpointSqliteWal", () => {
    it("reads documented SQLite column names first", async () => {
        const fakeClient = {
            $queryRawUnsafe: vi.fn(async () => [{ busy: 1n, log: 7n, checkpointed: 3n }]),
        } as unknown as PrismaClientType;

        await expect(checkpointSqliteWal(fakeClient)).resolves.toEqual({
            busy: 1,
            logFrames: 7,
            checkpointedFrames: 3,
        });
    });

    it("falls back to positional column order for driver-shaped rows", async () => {
        const fakeClient = {
            $queryRawUnsafe: vi.fn(async () => [{ 0: 0, 1: 11, 2: 9 }]),
        } as unknown as PrismaClientType;

        await expect(checkpointSqliteWal(fakeClient)).resolves.toEqual({
            busy: 0,
            logFrames: 11,
            checkpointedFrames: 9,
        });
    });
});

describe("maintainSqliteWal", () => {
    it("does not request a blocking WAL reset when PASSIVE already checkpointed every frame", async () => {
        const queryRawUnsafe = vi.fn(async () => [{ busy: 0, log: 12, checkpointed: 12 }]);
        const fakeClient = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaClientType;

        await expect(maintainSqliteWal(fakeClient)).resolves.toEqual({
            busy: 0,
            logFrames: 12,
            checkpointedFrames: 12,
        });
        expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
        expect(queryRawUnsafe).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
    });

    it("retains the active TRUNCATE attempt when PASSIVE leaves an uncheckpointed backlog", async () => {
        const queryRawUnsafe = vi.fn()
            .mockResolvedValueOnce([{ busy: 0, log: 12, checkpointed: 5 }])
            .mockResolvedValueOnce([{ busy: 1, log: 12, checkpointed: 9 }]);
        const fakeClient = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaClientType;

        await expect(maintainSqliteWal(fakeClient)).resolves.toEqual({
            busy: 1,
            logFrames: 12,
            checkpointedFrames: 9,
        });
        expect(queryRawUnsafe).toHaveBeenNthCalledWith(1, "PRAGMA wal_checkpoint(PASSIVE);");
        expect(queryRawUnsafe).toHaveBeenNthCalledWith(2, "PRAGMA wal_checkpoint(TRUNCATE);");
    });
});

describe("incrementalVacuumSqlite", () => {
    it("runs a bounded incremental vacuum batch", async () => {
        const fakeClient = {
            $executeRawUnsafe: vi.fn(async () => 0),
        } as unknown as PrismaClientType;

        await incrementalVacuumSqlite(fakeClient, 250);

        expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledWith("PRAGMA incremental_vacuum(250);");
    });
});

describe("startSqliteWalCheckpointWorker", () => {
    afterEach(() => {
        loggingMocks.log.mockReset();
        monitoringMocks.observe.mockReset();
        vi.useRealTimers();
    });

    it("returns null when disabled", () => {
        expect(startSqliteWalCheckpointWorker({ client, intervalMs: 0, runCheckpoint: async () => ok })).toBeNull();
    });

    it("checkpoints once per interval and stops after stop()", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                calls += 1;
                return ok;
            },
        });
        expect(handle).not.toBeNull();

        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toBe(1);
        expect(monitoringMocks.observe).toHaveBeenLastCalledWith(
            { operation: "wal_checkpoint", outcome: "ok" },
            0,
        );
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toBe(2);

        await handle!.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(calls).toBe(2);
    });

    it("reports whether a busy checkpoint only deferred the WAL reset or left frames uncheckpointed", async () => {
        vi.useFakeTimers();
        const results: SqliteWalCheckpointResult[] = [
            { busy: 1, logFrames: 12, checkpointedFrames: 12 },
            { busy: 1, logFrames: 12, checkpointedFrames: 5 },
            ok,
            { busy: 1, logFrames: 3, checkpointedFrames: 3 },
        ];
        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => results.shift() ?? ok,
        });

        await vi.advanceTimersByTimeAsync(1000);
        expect(loggingMocks.log).toHaveBeenLastCalledWith(
            {
                module: "storage",
                event: "sqlite-wal-checkpoint-busy",
                sqliteWalCheckpoint: {
                    busy: 1,
                    logFrames: 12,
                    checkpointedFrames: 12,
                    outcome: "wal-reset-deferred",
                    durationMs: 0,
                    retryIntervalMs: 1000,
                    consecutiveBusyCount: 1,
                },
            },
            expect.any(String),
        );

        await vi.advanceTimersByTimeAsync(1000);
        expect(loggingMocks.log).toHaveBeenLastCalledWith(
            {
                module: "storage",
                event: "sqlite-wal-checkpoint-busy",
                sqliteWalCheckpoint: {
                    busy: 1,
                    logFrames: 12,
                    checkpointedFrames: 5,
                    outcome: "checkpoint-incomplete",
                    durationMs: 0,
                    retryIntervalMs: 1000,
                    consecutiveBusyCount: 2,
                },
            },
            expect.any(String),
        );

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(loggingMocks.log).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sqliteWalCheckpoint: expect.objectContaining({
                    outcome: "wal-reset-deferred",
                    consecutiveBusyCount: 1,
                }),
            }),
            expect.any(String),
        );

        await handle!.stop();
    });

    it("does not overlap checkpoints when one is slower than the interval", async () => {
        vi.useFakeTimers();
        let started = 0;
        const releases: Array<() => void> = [];

        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                started += 1;
                await new Promise<void>((resolve) => {
                    releases.push(resolve);
                });
                return ok;
            },
        });

        await vi.advanceTimersByTimeAsync(1000); // run #1 starts, blocks on its gate
        expect(started).toBe(1);
        await vi.advanceTimersByTimeAsync(1000); // tick again: in-flight, must skip
        expect(started).toBe(1);

        releases[0](); // let run #1 finish
        await vi.advanceTimersByTimeAsync(1000); // next tick runs #2
        expect(started).toBe(2);

        releases.forEach((release) => release());
        await handle!.stop();
    });

    it("stop() waits for an in-flight checkpoint", async () => {
        vi.useFakeTimers();
        let finished = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                await gate;
                finished = true;
                return ok;
            },
        });

        await vi.advanceTimersByTimeAsync(1000); // run in flight, blocked on gate
        let stopResolved = false;
        const stopPromise = handle!.stop().then(() => {
            stopResolved = true;
        });
        await Promise.resolve();
        expect(stopResolved).toBe(false); // still awaiting the in-flight checkpoint
        expect(finished).toBe(false);

        release();
        await stopPromise;
        expect(finished).toBe(true);
    });
});

describe("startSqliteIncrementalVacuumWorker", () => {
    afterEach(() => {
        monitoringMocks.observe.mockReset();
        vi.useRealTimers();
    });

    it("returns null when disabled", () => {
        expect(startSqliteIncrementalVacuumWorker({
            client,
            intervalMs: 0,
            pages: 100,
            runVacuum: async () => undefined,
        })).toBeNull();
    });

    it("does not overlap vacuum batches when one is slower than the interval", async () => {
        vi.useFakeTimers();
        let started = 0;
        const releases: Array<() => void> = [];

        const handle = startSqliteIncrementalVacuumWorker({
            client,
            intervalMs: 1000,
            pages: 100,
            runVacuum: async () => {
                started += 1;
                await new Promise<void>((resolve) => {
                    releases.push(resolve);
                });
            },
        });

        await vi.advanceTimersByTimeAsync(1000);
        expect(started).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(started).toBe(1);

        releases[0]();
        await vi.advanceTimersByTimeAsync(1000);
        expect(started).toBe(2);

        releases.forEach((release) => release());
        await handle!.stop();
    });

    it("records successful maintenance duration through the canonical metrics registry", async () => {
        vi.useFakeTimers();
        const handle = startSqliteIncrementalVacuumWorker({
            client,
            intervalMs: 1000,
            pages: 100,
            runVacuum: async () => undefined,
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(monitoringMocks.observe).toHaveBeenCalledWith(
            { operation: "incremental_vacuum", outcome: "ok" },
            0,
        );
        await handle!.stop();
    });
});
