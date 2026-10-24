import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PENDING_DELIVERY_BLOCKED_REASONS } from "@happier-dev/protocol";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { enqueuePendingMessage, materializeNextPendingMessageForCurrentPublisher, resolveAcceptedPendingDelivery } from "./pendingMessageService";

const immediateReasons = new Set<string>([
    "delivery_outcome_uncertain", "ambiguous_terminal_delivery", "unknown",
    "runtime_disposed_before_delivery", "attempt_expired_before_write", "steering_unavailable",
]);

describe("materialization never holds later input behind a held head (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-held-head-", initAuth: true });
    }, 120_000);
    beforeEach(() => { harness.resetEnv(); });
    afterAll(async () => { await harness.close(); });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: "{}", metadataVersion: 0 },
        });
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: "encrypted" } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: account.id, machineId, sessionId: session.id };
        const registered = await presence.registerPublisher({
            socket: {}, binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`registration failed: ${registered.status}`);
        const common = { actorUserId: account.id, sessionId: session.id };
        const trustedPublisherFence = { ...binding, committedFence: registered.committedFence };
        const enqueue = async (localId: string) => {
            await expect(enqueuePendingMessage({
                ...common, localId, ciphertext: `cipher-${localId}`, messageRole: "user",
                requestedAction: { v: 1, kind: "enqueue" },
            })).resolves.toMatchObject({ ok: true });
        };
        const materialize = (heldLocalIds?: string[]) => {
            const params = {
                ...common, trustedPublisherFence, deliveryTiming: "after_foreground_ready" as const,
                foregroundState: "ready" as const, ...(heldLocalIds === undefined ? {} : { heldLocalIds }),
            };
            return materializeNextPendingMessageForCurrentPublisher(params);
        };
        return { session, common, trustedPublisherFence, enqueue, materialize };
    }

    it.each(PENDING_DELIVERY_BLOCKED_REASONS)("claims later enqueue input with a persisted %s head", async (reason) => {
        const f = await fixture();
        await f.enqueue("held");
        await f.enqueue("later");
        // Seed historical persisted state, including the settlement-only conditional-steer reason.
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "held" } },
            data: { deliveryState: "blocked", deliveryBlockedReason: reason },
        });
        await db.session.update({ where: { id: f.session.id }, data: { pendingBlockedCount: 1 } });

        await expect(f.materialize()).resolves.toMatchObject({
            ok: true, didMaterialize: true, message: { localId: "later", providerAction: "send" },
        });
        if (immediateReasons.has(reason)) {
            await expect(resolveAcceptedPendingDelivery({
                ...f.common, trustedPublisherFence: f.trustedPublisherFence, localId: "later",
            })).resolves.toMatchObject({ ok: true, didResolve: true });
            const next = await f.materialize();
            expect(next).toMatchObject({
                ok: true, didMaterialize: true,
                message: { content: { t: "encrypted", c: "cipher-held" }, requestedAction: { v: 1, kind: "enqueue" }, providerAction: "send" },
            });
            if (!next.ok || !next.didMaterialize) throw new Error("expected replacement claim");
            expect(next.message.localId).not.toBe("held");
        }
    });

    it("skips an external handoff head before its retry delay", async () => {
        const f = await fixture();
        await expect(enqueuePendingMessage({
            ...f.common, localId: "external", ciphertext: "external-cipher", messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" }, deliveryMode: "external_handoff",
        })).resolves.toMatchObject({ ok: true });
        await f.enqueue("later");
        await expect(f.materialize()).resolves.toMatchObject({
            ok: true, didMaterialize: true, message: { localId: "later", providerAction: "send" },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "external" } },
        })).resolves.toMatchObject({ status: "queued", deliveryState: "external_handoff" });
    });

    it.each(["malformed action", "storage-policy refusal"])("parks a %s head and continues in the same transaction", async (kind) => {
        const f = await fixture();
        await f.enqueue("invalid");
        await f.enqueue("later");
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "invalid" } },
            data: kind === "malformed action"
                ? { requestedAction: { v: 99, kind: "unsupported" } }
                : { content: { t: "plain", v: { role: "user", content: { type: "text", text: "plaintext in an e2ee session" } } } },
        });
        await expect(f.materialize()).resolves.toMatchObject({
            ok: true, didMaterialize: true, pendingCount: 2, pendingBlockedCount: 1,
            message: { localId: "later" },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "invalid" } },
        })).resolves.toMatchObject({ status: "queued", deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" });
    });

    it("reoffers a transcript collision and claims later input without failing the call", async () => {
        const f = await fixture();
        await f.enqueue("collision");
        await f.enqueue("later");
        await db.session.update({ where: { id: f.session.id }, data: { seq: 1 } });
        await db.sessionMessage.create({ data: {
            sessionId: f.session.id, seq: 1, localId: "collision", messageRole: "user",
            content: { t: "encrypted", c: "different-transcript-cipher" },
        } });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "later" } });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "collision" } },
        })).resolves.toMatchObject({ status: "discarded", discardedReason: "resent_as_new" });
        const replacement = await db.sessionPendingMessage.findFirstOrThrow({
            where: { sessionId: f.session.id, status: "queued", localId: { not: "later" } },
        });
        expect(replacement).toMatchObject({ content: { t: "encrypted", c: "cipher-collision" }, requestedAction: { v: 1, kind: "enqueue" } });
        expect(replacement.localId).not.toBe("collision");
        await expect(resolveAcceptedPendingDelivery({ ...f.common, trustedPublisherFence: f.trustedPublisherFence, localId: "later" }))
            .resolves.toMatchObject({ ok: true, didResolve: true });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: replacement.localId } });
    });

    it("skips claims named by the runner's heldLocalIds", async () => {
        const f = await fixture();
        await f.enqueue("held");
        await f.enqueue("later");
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "held" } });
        await expect(f.materialize(["held"])).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "later" } });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: f.session.id, deliveryState: "delivering" } })).resolves.toBe(2);
    });

    it("preserves the b4c01896 client's rejoin behavior when heldLocalIds is omitted", async () => {
        const f = await fixture();
        await f.enqueue("held");
        await f.enqueue("later");
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "held" } });
        await expect(f.materialize()).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: "held" } });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: f.session.id, localId: "later" } },
        })).resolves.toMatchObject({ deliveryState: null });
    });
});
