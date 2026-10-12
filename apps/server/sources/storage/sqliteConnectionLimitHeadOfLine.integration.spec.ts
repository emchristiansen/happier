import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import {
    createDbSqliteMaintenanceClient,
    db,
} from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function readPrimaryBusyConnectionCount(): Promise<number> {
    const metrics = await db.$metrics.json();
    return metrics.gauges.find((metric) => metric.key === "prisma_pool_connections_busy")?.value ?? 0;
}

describe("SQLite connection_limit=1 head-of-line attribution", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-head-of-line-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("shows a blocked write occupying the sole primary connection and stalling later reads", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-sqlite-head-of-line-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `tag-sqlite-head-of-line-${randomUUID()}`,
                accountId: account.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const externalWriter = await createDbSqliteMaintenanceClient();
        await externalWriter.$connect();
        const writerEntered = deferred();
        const releaseWriter = deferred();
        const writer = externalWriter.$transaction(async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
        }, { maxWait: 2_000, timeout: 5_000 });

        try {
            await writerEntered.promise;

            // WAL still permits a read while another connection owns the writer lock.
            await expect(db.account.findUnique({
                where: { id: account.id },
                select: { id: true },
            })).resolves.toEqual({ id: account.id });

            let enqueueSettled = false;
            const enqueue = enqueuePendingMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: `pending-sqlite-head-of-line-${randomUUID()}`,
                ciphertext: "cipher-sqlite-head-of-line",
                requestedAction: { v: 1, kind: "enqueue" },
                diagnosticCorrelationId: "probe-sqlite-head-of-line",
            }).finally(() => {
                enqueueSettled = true;
            });

            await vi.waitFor(async () => {
                expect(await readPrimaryBusyConnectionCount()).toBe(1);
            }, { timeout: 2_000, interval: 10 });

            let laterReadSettled = false;
            const laterRead = db.account.findUnique({
                where: { id: account.id },
                select: { id: true },
            }).finally(() => {
                laterReadSettled = true;
            });

            await new Promise((resolve) => setTimeout(resolve, 75));
            expect(enqueueSettled).toBe(false);
            expect(laterReadSettled).toBe(false);

            releaseWriter.resolve();
            await writer;
            await expect(enqueue).resolves.toMatchObject({ ok: true, didWrite: true });
            await expect(laterRead).resolves.toEqual({ id: account.id });
        } finally {
            releaseWriter.resolve();
            await writer.catch(() => {});
            await externalWriter.$disconnect();
        }
    });
});
