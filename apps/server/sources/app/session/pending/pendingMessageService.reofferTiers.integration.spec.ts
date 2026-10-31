import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PendingDeliveryBlockedReason, PendingRequestedActionV1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { eventRouter, type ClientConnection, type UpdatePayload } from "@/app/events/eventRouter";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { enqueuePendingMessage, materializeNextPendingMessageForCurrentPublisher, resolveAcceptedPendingDelivery, sendPendingDeliveryAsNew } from "./pendingMessageService";
import { derivePendingSendAsNewLocalId } from "./reofferPendingRowAsNewInTx";

const immediateReasons = [
    "delivery_outcome_uncertain", "ambiguous_terminal_delivery", "unknown",
    "runtime_disposed_before_delivery", "attempt_expired_before_write", "steering_unavailable",
] as const satisfies readonly PendingDeliveryBlockedReason[];
const delayedReasons = [
    "provider_rejected_before_acceptance", "provider_unavailable_before_acceptance",
    "terminal_host_unreachable", "runtime_config_blocked", "terminal_composer_draft",
] as const satisfies readonly PendingDeliveryBlockedReason[];
const terminalReasons = [
    "unsupported_action", "invalid_prompt_text", "payload_too_large", "manual_user_handled",
] as const satisfies readonly PendingDeliveryBlockedReason[];

describe("pending delivery reoffer tiers (real SQLite)", () => {
    let harness: LightSqliteHarness;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    const connections: Array<{ userId: string; connection: ClientConnection }> = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-reoffer-tiers-", initAuth: true });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        sessionPendingRoutes(app);
        await app.ready();
    }, 120_000);
    beforeEach(() => { harness.resetEnv(); });
    afterEach(() => {
        for (const { userId, connection } of connections.splice(0)) eventRouter.removeConnection(userId, connection);
    });
    afterAll(async () => {
        await app.close();
        await harness.close();
    });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: "{}", metadataVersion: 0 },
        });
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: "encrypted" } });
        const binding = { accountId: account.id, machineId, sessionId: session.id };
        const presence = createSessionPublisherPresence();
        const publisherSocket = createFakeSocket({ id: randomUUID() });
        const registered = await presence.registerPublisher({
            socket: publisherSocket, binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`registration failed: ${registered.status}`);
        const trustedPublisherFence = { ...binding, committedFence: registered.committedFence };
        const common = { actorUserId: account.id, sessionId: session.id };
        // The canonical socket testkit supplies only the transport; publisher authority stays real.
        const providerSocket = publisherSocket as unknown as Socket;
        sessionUpdateHandler(account.id, providerSocket, {
            connectionType: "session-scoped", userId: account.id, sessionId: session.id, socket: providerSocket,
        }, { presence, binding });
        const materializeThroughSocket = async () => {
            let answer: unknown;
            await getSocketHandler(publisherSocket, "pending-materialize-next")({
                sid: session.id, deliveryState: "provider", deliveryTiming: "after_foreground_ready", foregroundState: "ready",
            }, (response: unknown) => { answer = response; });
            return answer;
        };
        const updates: UpdatePayload[] = [];
        // Socket.IO transport is the system boundary; persistence, publication and routing stay real.
        const socket = createFakeSocket({ id: randomUUID() });
        socket.emit.mockImplementation((event: string, payload: UpdatePayload) => {
            if (event === "update") updates.push(payload);
        });
        const connection: ClientConnection = { connectionType: "user-scoped", userId: account.id, socket: socket as unknown as Socket };
        connections.push({ userId: account.id, connection });
        eventRouter.addConnection(account.id, connection);
        const token = await auth.createToken(account.id);
        const enqueue = async (localId: string, requestedAction: PendingRequestedActionV1 = { v: 1, kind: "enqueue" }, resumeWhenAvailable?: true) => {
            await expect(enqueuePendingMessage({
                ...common, localId, ciphertext: `cipher-${localId}`, messageRole: "user", requestedAction,
                ...(resumeWhenAvailable === undefined ? {} : { resumeWhenAvailable }),
            })).resolves.toMatchObject({ ok: true });
        };
        const materialize = (foregroundState: "ready" | "active_unsteerable" = "ready") => materializeNextPendingMessageForCurrentPublisher({
            ...common, trustedPublisherFence, foregroundState, deliveryTiming: "after_foreground_ready",
        });
        const block = async (localId: string, reason: PendingDeliveryBlockedReason) => {
            const response = await app.inject({
                method: "POST", url: `/v2/sessions/${session.id}/pending/${localId}/delivery/block`,
                headers: { authorization: `Bearer ${token}` }, payload: { reason },
            });
            expect(response.statusCode).toBe(200);
            return response.json();
        };
        const row = (localId: string) => db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
        });
        const state = () => db.session.findUniqueOrThrow({ where: { id: session.id } });
        const replacement = () => db.sessionPendingMessage.findFirstOrThrow({
            where: { sessionId: session.id, status: "queued", localId: { notIn: ["original", "later"] } },
        });
        const age = (localId: string) => db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 60_001) },
        });
        return { account, session, common, trustedPublisherFence, updates, enqueue, materialize, materializeThroughSocket, block, row, state, replacement, age };
    }

    it.each(immediateReasons)("immediately reoffers %s at the tail and publishes committed counters", async (reason) => {
        const f = await fixture();
        await f.enqueue("original");
        await f.enqueue("later");
        const before = await f.state();
        const response = await f.block("original", reason);
        expect(response).toMatchObject({ ok: true, pendingCount: 2, pendingBlockedCount: 0 });
        expect(response.pendingVersion).toBeGreaterThan(before.pendingVersion);
        const original = await f.row("original");
        expect(original).toMatchObject({ status: "discarded", discardedReason: "resent_as_new", deliveryState: null, deliveryBlockedReason: null });
        const replacement = await f.replacement();
        expect(replacement).toMatchObject({
            status: "queued", deliveryState: null, deliveryBlockedReason: null, providerAction: null,
            messageRole: "user", authorAccountId: f.account.id,
            content: { t: "encrypted", c: "cipher-original" }, requestedAction: { v: 1, kind: "enqueue" },
        });
        expect(replacement.localId).not.toBe("original");
        expect(replacement.position).toBeGreaterThan((await f.row("later")).position);
        expect(await f.state()).toMatchObject({ pendingCount: 2, pendingBlockedCount: 0, pendingVersion: response.pendingVersion });
        expect(f.updates.filter((update) => update.body.t === "pending-changed")).toContainEqual(expect.objectContaining({
            body: expect.objectContaining({ t: "pending-changed", sessionId: f.session.id, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: response.pendingVersion }),
        }));
        await expect(db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: f.account.id, kind: "session", entityId: f.session.id },
        } })).resolves.toMatchObject({ hint: expect.objectContaining({ pendingCount: 2, pendingBlockedCount: 0, pendingVersion: response.pendingVersion }) });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "later" } });
    });

    it.each(delayedReasons)("delays %s until materialization after 60 seconds", async (reason) => {
        const f = await fixture();
        await f.enqueue("original");
        await f.block("original", reason);
        await expect(f.row("original")).resolves.toMatchObject({ status: "queued", deliveryState: "blocked", deliveryBlockedReason: reason });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: false });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
        const before = await f.state();
        await f.age("original");
        const claim = await f.materializeThroughSocket();
        expect(claim).toMatchObject({ ok: true, didMaterialize: true, pendingCount: 1, pendingBlockedCount: 0,
            message: { content: { t: "encrypted", c: "cipher-original" }, requestedAction: { v: 1, kind: "enqueue" }, providerAction: "send" } });
        const replacement = await f.replacement();
        expect(replacement.localId).not.toBe("original");
        expect(replacement.deliveryState).toBe("delivering");
        const after = await f.state();
        expect(after.pendingVersion).toBeGreaterThan(before.pendingVersion);
        await expect(f.row("original")).resolves.toMatchObject({ status: "discarded", discardedReason: "resent_as_new" });
        expect(after).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0 });
        await expect(db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: f.account.id, kind: "session", entityId: f.session.id },
        } })).resolves.toMatchObject({ hint: expect.objectContaining({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: after.pendingVersion }) });
        expect(f.updates.filter((update) => update.body.t === "pending-changed")).toContainEqual(expect.objectContaining({
            body: expect.objectContaining({ t: "pending-changed", sessionId: f.session.id, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: after.pendingVersion }),
        }));
    });

    it.each(terminalReasons)("never reoffers terminal %s and still claims later input", async (reason) => {
        const f = await fixture();
        await f.enqueue("original");
        await f.block("original", reason);
        await f.age("original");
        await f.enqueue("later");
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, pendingCount: 2, pendingBlockedCount: 1, message: { localId: "later" } });
        await expect(f.row("original")).resolves.toMatchObject({ status: "queued", deliveryState: "blocked", deliveryBlockedReason: reason });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: f.session.id } })).resolves.toBe(2);
    });

    it("reoffers an expired external handoff as enqueue", async () => {
        const f = await fixture();
        await expect(enqueuePendingMessage({ ...f.common, localId: "original", ciphertext: "external-cipher", messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" }, deliveryMode: "external_handoff" })).resolves.toMatchObject({ ok: true });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: false });
        await f.age("original");
        const result = await f.materialize();
        expect(result).toMatchObject({ ok: true, didMaterialize: true, pendingCount: 1, pendingBlockedCount: 0,
            message: { content: { t: "encrypted", c: "external-cipher" }, requestedAction: { v: 1, kind: "enqueue" }, providerAction: "send" } });
        if (!result.ok || !result.didMaterialize) throw new Error("expected external handoff replacement");
        expect(result.message.localId).not.toBe("original");
        await expect(f.row("original")).resolves.toMatchObject({ status: "discarded", discardedReason: "resent_as_new" });
    });

    it("never repeats send_now's interrupt when its replacement meets an active foreground turn", async () => {
        const f = await fixture();
        await f.enqueue("original", { v: 1, kind: "send_now" });
        await f.block("original", "delivery_outcome_uncertain");
        const replacement = await f.replacement();
        expect(replacement.requestedAction).toEqual({ v: 1, kind: "enqueue" });
        await expect(f.materialize("active_unsteerable")).resolves.toMatchObject({
            ok: true, didMaterialize: false, deferredReason: "waiting_for_foreground_turn",
        });
        await expect(f.row(replacement.localId)).resolves.toMatchObject({ deliveryState: null, providerAction: null });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true,
            message: { localId: replacement.localId, providerAction: "send" } });
    });

    it("settles late acceptance of an automatic tombstone while preserving its replacement", async () => {
        const f = await fixture();
        await f.enqueue("original");
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true });
        await f.block("original", "delivery_outcome_uncertain");
        const replacement = await f.replacement();
        await expect(resolveAcceptedPendingDelivery({ ...f.common, localId: "original", trustedPublisherFence: f.trustedPublisherFence }))
            .resolves.toMatchObject({ ok: true, didResolve: true, pendingCount: 1, pendingBlockedCount: 0 });
        await expect(db.sessionMessage.findFirstOrThrow({ where: { sessionId: f.session.id, localId: "original" } }))
            .resolves.toMatchObject({ content: { t: "encrypted", c: "cipher-original" }, messageRole: "user" });
        await expect(f.row(replacement.localId)).resolves.toMatchObject({ status: "queued", deliveryState: null });
    });

    it("carries resume-when-available authorization to the replacement of an inactive session", async () => {
        const f = await fixture();
        await db.session.update({ where: { id: f.session.id }, data: { active: false } });
        await f.enqueue("original", { v: 1, kind: "enqueue" }, true);
        const before = await f.state();
        expect(before.pendingActivationRequestId).toBe("original");
        await f.block("original", "runtime_disposed_before_delivery");
        const replacement = await f.replacement();
        const after = await f.state();
        expect(after).toMatchObject({ active: false, pendingActivationRequestId: replacement.localId, pendingActivationStatus: "waiting", pendingActivationFailureCode: null });
        expect(after.pendingActivationRequestedAt!.getTime()).toBeGreaterThan(after.lastActiveAt.getTime());
        await expect(db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: f.account.id, kind: "session", entityId: f.session.id },
        } })).resolves.toMatchObject({ hint: expect.objectContaining({ pendingActivationRequestId: replacement.localId }) });
        expect(f.updates.filter((update) => update.body.t === "pending-changed")).toContainEqual(expect.objectContaining({
            body: expect.objectContaining({ pendingActivationAuthorization: expect.objectContaining({ requestId: replacement.localId, status: "waiting" }) }),
        }));
    });

    it("keeps manual retry identity stable when the deterministic ID exists only in the transcript", async () => {
        const f = await fixture();
        await f.enqueue("original");
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true });
        const replacementLocalId = derivePendingSendAsNewLocalId(f.session.id, "original");
        await db.session.update({ where: { id: f.session.id }, data: { seq: 1 } });
        await db.sessionMessage.create({ data: {
            sessionId: f.session.id, seq: 1, localId: replacementLocalId, messageRole: "user",
            content: { t: "encrypted", c: "prior-transcript" },
        } });
        await expect(sendPendingDeliveryAsNew({ ...f.common, localId: "original" }))
            .resolves.toMatchObject({ ok: true, didWrite: true });
        await expect(sendPendingDeliveryAsNew({ ...f.common, localId: "original" }))
            .resolves.toMatchObject({ ok: true, didWrite: false });
        await expect(f.row(replacementLocalId)).resolves.toMatchObject({ status: "queued", content: { t: "encrypted", c: "cipher-original" } });
        await expect(db.sessionMessage.findFirstOrThrow({ where: { sessionId: f.session.id, localId: replacementLocalId } }))
            .resolves.toMatchObject({ content: { t: "encrypted", c: "prior-transcript" } });
    });

    it("keeps manual send-as-new guards and idempotent replacement semantics", async () => {
        const f = await fixture();
        await f.enqueue("original");
        await expect(sendPendingDeliveryAsNew({ ...f.common, localId: "original" })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(sendPendingDeliveryAsNew({ ...f.common, localId: "original" })).resolves.toMatchObject({ ok: true, didWrite: true, pendingCount: 1 });
        await expect(sendPendingDeliveryAsNew({ ...f.common, localId: "original" })).resolves.toMatchObject({ ok: true, didWrite: false, pendingCount: 1 });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: f.session.id, status: "queued" } })).resolves.toBe(1);
    });
});
