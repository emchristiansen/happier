import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

/**
 * The session detail route reports the queue head that holds ordinary pending rows back, so a
 * runner and a daemon reading session state can see a stall. It runs the real route, the real
 * Prisma read and the real Fastify response serializer.
 */

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

describe("session detail reports the blocking pending queue head (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-pending-blocking-head-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function seedSession() {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);
        const session = await db.session.create({
            data: { accountId: account.id, tag: `blocking-head-${randomUUID()}`, metadata: "{}" },
            select: { id: true },
        });
        return { accountId: account.id, token, sessionId: session.id };
    }

    async function enqueue(seeded: { accountId: string; sessionId: string }, localId: string) {
        await expect(enqueuePendingMessage({
            actorUserId: seeded.accountId,
            sessionId: seeded.sessionId,
            localId,
            ciphertext: `cipher-${localId}`,
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toMatchObject({ ok: true });
    }

    async function setRow(sessionId: string, localId: string, data: Record<string, unknown>) {
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId } },
            data,
        });
        return await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId, localId } },
            select: { updatedAt: true },
        });
    }

    async function readSession(token: string, sessionId: string) {
        const app = createTestApp();
        const response = await app.inject({
            method: "GET",
            url: `/v2/sessions/${sessionId}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        return response.json().session as Record<string, unknown>;
    }

    it("reports a blocked head with its reason and its age since its last update", async () => {
        const seeded = await seedSession();
        const head = `head-${randomUUID()}`;
        await enqueue(seeded, head);
        await enqueue(seeded, `next-${randomUUID()}`);
        const headRow = await setRow(seeded.sessionId, head, {
            deliveryState: "blocked",
            deliveryBlockedReason: "provider_rejected_before_acceptance",
            providerAction: "send",
        });

        const session = await readSession(seeded.token, seeded.sessionId);
        expect(session.pendingQueueBlockingHead).toEqual({
            localId: head,
            deliveryState: "blocked",
            blockedReason: "provider_rejected_before_acceptance",
            lastUpdatedAt: headRow.updatedAt.getTime(),
            ageSinceLastUpdateMs: expect.any(Number),
        });
        expect((session.pendingQueueBlockingHead as { ageSinceLastUpdateMs: number }).ageSinceLastUpdateMs)
            .toBeGreaterThanOrEqual(0);
    });

    it("reports a delivering head", async () => {
        const seeded = await seedSession();
        const head = `delivering-${randomUUID()}`;
        await enqueue(seeded, head);
        const headRow = await setRow(seeded.sessionId, head, { deliveryState: "delivering", providerAction: "send" });

        const session = await readSession(seeded.token, seeded.sessionId);
        expect(session.pendingQueueBlockingHead).toEqual({
            localId: head,
            deliveryState: "delivering",
            lastUpdatedAt: headRow.updatedAt.getTime(),
            ageSinceLastUpdateMs: expect.any(Number),
        });
    });

    it("reports the row behind an unsupported_action head, which ordinary rows pass", async () => {
        const seeded = await seedSession();
        const unsupported = `unsupported-${randomUUID()}`;
        const rawUnsupported = `raw-unsupported-${randomUUID()}`;
        const blocked = `blocked-${randomUUID()}`;
        await enqueue(seeded, unsupported);
        await enqueue(seeded, rawUnsupported);
        await enqueue(seeded, blocked);
        await setRow(seeded.sessionId, unsupported, {
            deliveryState: "blocked",
            deliveryBlockedReason: "unsupported_action",
            providerAction: "send",
        });
        await setRow(seeded.sessionId, rawUnsupported, { requestedAction: { v: 1, kind: "future_action" } });
        await setRow(seeded.sessionId, blocked, {
            deliveryState: "blocked",
            deliveryBlockedReason: "delivery_outcome_uncertain",
            providerAction: "send",
        });

        const session = await readSession(seeded.token, seeded.sessionId);
        expect(session.pendingQueueBlockingHead).toMatchObject({
            localId: blocked,
            deliveryState: "blocked",
            blockedReason: "delivery_outcome_uncertain",
        });
    });

    it("reports no head when the oldest row is deliverable, or when only unsupported rows remain", async () => {
        const deliverable = await seedSession();
        await enqueue(deliverable, `ordinary-${randomUUID()}`);
        expect((await readSession(deliverable.token, deliverable.sessionId)).pendingQueueBlockingHead).toBeNull();

        const onlyUnsupported = await seedSession();
        const unsupported = `unsupported-${randomUUID()}`;
        await enqueue(onlyUnsupported, unsupported);
        await setRow(onlyUnsupported.sessionId, unsupported, {
            deliveryState: "blocked",
            deliveryBlockedReason: "unsupported_action",
            providerAction: "send",
        });
        expect((await readSession(onlyUnsupported.token, onlyUnsupported.sessionId)).pendingQueueBlockingHead).toBeNull();

        const empty = await seedSession();
        expect((await readSession(empty.token, empty.sessionId)).pendingQueueBlockingHead).toBeNull();
    });
});
