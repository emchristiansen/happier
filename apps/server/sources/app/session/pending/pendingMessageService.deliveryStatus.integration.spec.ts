import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("exact pending delivery status route (real SQLite)", () => {
    let harness: LightSqliteHarness;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-exact-pending-status-", initAuth: true });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        sessionPendingRoutes(app);
        await app.ready();
    }, 120_000);

    afterAll(async () => {
        await app.close();
        await harness.close();
    });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", metadataVersion: 0 },
        });
        const localId = " exact opaque claim ";
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id, localId, messageRole: "user", content: { t: "encrypted", c: "private prompt" },
                requestedAction: { v: 1, kind: "send_now" }, status: "discarded", deliveryState: null,
                discardedReason: "resent_as_new", discardedAt: new Date(), position: 1,
                authorAccountId: owner.id,
            },
        });
        const token = await auth.createToken(owner.id);
        const read = (actorToken = token, id = localId, sid = session.id) => app.inject({
            method: "GET", url: `/v2/sessions/${encodeURIComponent(sid)}/pending/${encodeURIComponent(id)}/status`,
            headers: { authorization: `Bearer ${actorToken}` },
        });
        return { owner, session, localId, token, read };
    }

    it("returns only the exact hidden tombstone status without changing the listing or state", async () => {
        const f = await fixture();
        const before = await db.session.findUniqueOrThrow({ where: { id: f.session.id } });
        const rowBefore = await db.sessionPendingMessage.findMany({ where: { sessionId: f.session.id } });
        const response = await f.read();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ localId: f.localId, deliveryStatus: { status: "discarded", reason: "resent_as_new" } });
        const listed = await app.inject({
            method: "GET", url: `/v2/sessions/${f.session.id}/pending?includeDiscarded=true`,
            headers: { authorization: `Bearer ${f.token}` },
        });
        expect(listed.json()).toEqual({ pending: [] });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(before);
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: f.session.id } })).toEqual(rowBefore);
    });

    it.each(["view", "edit", "admin"] as const)("denies a shared %s participant the owner-only status route", async (accessLevel) => {
        const f = await fixture();
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        await db.sessionShare.create({
            data: {
                sessionId: f.session.id, sharedWithUserId: participant.id, sharedByUserId: f.owner.id, accessLevel,
                canApprovePermissions: false, encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]),
            },
        });
        const response = await f.read(await auth.createToken(participant.id));
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "forbidden" });
    });

    it("requires authentication and keeps missing rows distinct from a recovery outcome", async () => {
        const f = await fixture();
        expect((await app.inject({ method: "GET", url: `/v2/sessions/${f.session.id}/pending/A/status` })).statusCode).toBe(401);
        const missing = await f.read(f.token, "missing");
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "not-found" });
        const outsider = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        expect((await f.read(await auth.createToken(outsider.id))).statusCode).toBe(404);
        expect((await f.read(f.token, f.localId, "missing-session")).statusCode).toBe(404);
    });
});
