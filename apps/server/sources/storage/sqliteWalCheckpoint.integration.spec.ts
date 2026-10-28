import { statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { applySqliteRuntimePragmas, createDbSqliteMaintenanceClient, db } from "@/storage/db";
import { checkpointSqliteWal, maintainSqliteWal } from "@/storage/sqliteWalCheckpoint";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function walSizeBytes(dbPath: string): number {
    try {
        return statSync(`${dbPath}-wal`).size;
    } catch {
        return 0;
    }
}

describe("storage/sqliteWalCheckpoint (integration)", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
    });

    it("truncates the WAL file back to zero (prevents checkpoint starvation growth)", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-wal-checkpoint-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        // Grow the WAL with committed writes. Stay under the ~4MB default autocheckpoint
        // threshold so the WAL is non-empty when we checkpoint explicitly.
        await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _wal_probe (id INTEGER PRIMARY KEY, payload TEXT);");
        const payload = "x".repeat(1024);
        for (let i = 0; i < 500; i++) {
            await db.$executeRawUnsafe("INSERT INTO _wal_probe (payload) VALUES (?);", payload);
        }

        // The WAL file is allocated and non-empty before an explicit truncate checkpoint.
        // (Passive autocheckpoint may move frames into the db, but it never shrinks the
        // -wal file itself — only TRUNCATE/RESTART does, which is the behavior under test.)
        expect(walSizeBytes(harness.dbPath)).toBeGreaterThan(0);

        const result = await checkpointSqliteWal(db);

        expect(result.busy).toBe(0);
        expect(walSizeBytes(harness.dbPath)).toBe(0);
    });

    it("reproduces checkpoint-to-writer-to-read head-of-line blocking with one primary connection", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-wal-checkpoint-contention-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        await db.$queryRawUnsafe("PRAGMA wal_autocheckpoint=0;");
        const account = await db.account.create({
            data: { publicKey: "pk-wal-checkpoint-contention" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { tag: "wal-checkpoint-contention", accountId: account.id, metadata: "meta" },
            select: { id: true },
        });
        const reader = await createDbSqliteMaintenanceClient();
        const checkpointer = await createDbSqliteMaintenanceClient();
        await Promise.all([reader.$connect(), checkpointer.$connect()]);
        await applySqliteRuntimePragmas(checkpointer, {
            ...process.env,
            HAPPIER_SQLITE_BUSY_TIMEOUT_MS: "500",
            HAPPY_SQLITE_BUSY_TIMEOUT_MS: "500",
        });

        try {
            // Keep WAL frames present, then hold a read snapshot over all of them. This produces
            // SQLite's exact `busy=1, log=checkpointed` WAL-reset-deferred result.
            await db.account.create({ data: { publicKey: "pk-wal-checkpoint-contention-frame" } });
            await reader.$executeRawUnsafe("BEGIN DEFERRED;");
            await reader.account.findUnique({ where: { id: account.id }, select: { id: true } });

            const passive = await maintainSqliteWal(checkpointer);
            expect(passive.busy).toBe(0);
            expect(passive.logFrames).toBeGreaterThan(0);
            expect(passive.checkpointedFrames).toBe(passive.logFrames);

            const checkpointPromise = checkpointSqliteWal(checkpointer);
            await new Promise((resolve) => setTimeout(resolve, 25));

            let enqueueSettled = false;
            const enqueuePromise = enqueuePendingMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: "wal-checkpoint-contention-pending",
                ciphertext: "cipher",
                requestedAction: { v: 1, kind: "enqueue" },
                diagnosticCorrelationId: "wal-checkpoint-contention",
            }).finally(() => {
                enqueueSettled = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 25));

            let laterReadSettled = false;
            const laterReadPromise = db.account.findUnique({
                where: { id: account.id },
                select: { id: true },
            }).finally(() => {
                laterReadSettled = true;
            });

            await new Promise((resolve) => setTimeout(resolve, 75));
            expect(enqueueSettled).toBe(false);
            expect(laterReadSettled).toBe(false);

            const checkpoint = await checkpointPromise;
            expect(checkpoint.busy).toBe(1);
            expect(checkpoint.logFrames).toBeGreaterThan(0);
            expect(checkpoint.checkpointedFrames).toBe(checkpoint.logFrames);
            await expect(enqueuePromise).resolves.toMatchObject({ ok: true, didWrite: true });
            await expect(laterReadPromise).resolves.toEqual({ id: account.id });
            await expect(db.sessionPendingMessage.findUnique({
                where: {
                    sessionId_localId: {
                        sessionId: session.id,
                        localId: "wal-checkpoint-contention-pending",
                    },
                },
                select: { localId: true },
            })).resolves.toEqual({ localId: "wal-checkpoint-contention-pending" });
        } finally {
            await reader.$executeRawUnsafe("ROLLBACK;").catch(() => {});
            await Promise.all([reader.$disconnect(), checkpointer.$disconnect()]);
        }
    });
});
