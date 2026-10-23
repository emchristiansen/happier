import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/storage/db";
import type { PendingDeliveryBlockedReason, PendingRequestedActionV1 } from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import {
    blockPendingDelivery,
    enqueuePendingMessage,
    materializeNextPendingMessageForCurrentPublisher,
} from "./pendingMessageService";

/**
 * Which queue heads ordinary rows may pass. Only a head that can never be delivered (its requested
 * action is one this server cannot parse: blocked `unsupported_action`, persisted or as the server's
 * projection of a raw queued row) lets later ordinary rows through. Every other head keeps them
 * waiting, and the server reports that head so the stall is visible; nothing acts on it.
 */
describe("materializeNextPendingMessage queue heads", () => {
    let harness: LightSqliteHarness;
    type TrustedPublisherFence = Parameters<
        typeof materializeNextPendingMessageForCurrentPublisher
    >[0]["trustedPublisherFence"];
    const fenceBySession = new Map<string, TrustedPublisherFence>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-blocked-head-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
        fenceBySession.clear();
    });

    const createOwnerSession = async (kind: string) => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${kind}-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId: owner.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        return { ownerId: owner.id, sessionId: session.id };
    };

    const currentFence = async (accountId: string, sessionId: string): Promise<TrustedPublisherFence> => {
        const existing = fenceBySession.get(sessionId);
        if (existing) return existing;
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId, machineId, sessionId, data: "encrypted" } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId, machineId, sessionId };
        const registered = await presence.registerPublisher({
            socket: {},
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`publisher registration failed: ${registered.status}`);
        const fence = { ...binding, committedFence: registered.committedFence };
        fenceBySession.set(sessionId, fence);
        return fence;
    };

    const materialize = async (
        ownerId: string,
        sessionId: string,
        foregroundState: "ready" | "active_steerable" | "active_unsteerable" = "ready",
    ) => await materializeNextPendingMessageForCurrentPublisher({
        actorUserId: ownerId,
        sessionId,
        deliveryTiming: "after_foreground_ready",
        foregroundState,
        trustedPublisherFence: await currentFence(ownerId, sessionId),
    });

    const enqueue = async (
        ownerId: string,
        sessionId: string,
        localId: string,
        options: Readonly<{ requestedAction?: PendingRequestedActionV1; deliveryMode?: "external_handoff" }> = {},
    ) => {
        await expect(enqueuePendingMessage({
            actorUserId: ownerId,
            sessionId,
            localId,
            ciphertext: `cipher-${localId}`,
            requestedAction: options.requestedAction ?? { v: 1, kind: "enqueue" },
            ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
        } as Parameters<typeof enqueuePendingMessage>[0])).resolves.toMatchObject({ ok: true });
    };

    /** The real path to a blocked head: the runner claims the oldest row, then settles it blocked. */
    const claimHeadThenBlock = async (
        ownerId: string,
        sessionId: string,
        headLocalId: string,
        reason: PendingDeliveryBlockedReason,
    ) => {
        const claimed = await materialize(ownerId, sessionId);
        expect(claimed).toMatchObject({ ok: true, didMaterialize: true, message: { localId: headLocalId } });
        await expect(blockPendingDelivery({
            actorUserId: ownerId,
            sessionId,
            localId: headLocalId,
            reason,
        })).resolves.toMatchObject({ ok: true, didUpdate: true });
    };

    const readRows = async (sessionId: string) => await db.sessionPendingMessage.findMany({
        where: { sessionId },
        orderBy: [{ position: "asc" }, { localId: "asc" }],
        select: { localId: true, status: true, deliveryState: true, deliveryBlockedReason: true },
    });

    const readCounters = async (sessionId: string) => await db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true },
    });

    it("lets an ordinary row pass a head persisted as blocked unsupported_action", async () => {
        const { ownerId, sessionId } = await createOwnerSession("unsupported-persisted");
        const head = `head-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await claimHeadThenBlock(ownerId, sessionId, head, "unsupported_action");

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: next, requestedAction: { v: 1, kind: "enqueue" }, providerAction: "send" },
            pendingCount: 2,
            pendingBlockedCount: 1,
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
            { localId: next, status: "queued", deliveryState: "delivering", deliveryBlockedReason: null },
        ]);
    });

    it("lets an ordinary row pass a raw queued head whose action the server cannot parse, storing the head's projected block", async () => {
        const { ownerId, sessionId } = await createOwnerSession("unsupported-raw");
        const head = `raw-head-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        await expect(readCounters(sessionId)).resolves.toEqual({ pendingCount: 2, pendingBlockedCount: 0 });

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: next },
            pendingCount: 2,
            pendingBlockedCount: 1,
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
            { localId: next, status: "queued", deliveryState: "delivering", deliveryBlockedReason: null },
        ]);
        await expect(readCounters(sessionId)).resolves.toEqual({ pendingCount: 2, pendingBlockedCount: 1 });
    });

    it("stores the projected block of a raw unparseable head even when nothing else is queued", async () => {
        const { ownerId, sessionId } = await createOwnerSession("unsupported-raw-alone");
        const head = `raw-alone-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        const before = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { pendingVersion: true } });

        const result = await materialize(ownerId, sessionId);
        expect(result).toMatchObject({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: before.pendingVersion + 1,
            pendingStateChanged: true,
        });
        expect(result).not.toHaveProperty("deferredReason");
        expect(result).not.toHaveProperty("blockingHead");
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
        ]);
    });

    it.each([
        // Blocked after a provider outcome that may have taken effect.
        "delivery_outcome_uncertain",
        "ambiguous_terminal_delivery",
        // Blocked before any provider effect.
        "provider_rejected_before_acceptance",
        "provider_unavailable_before_acceptance",
        "steering_unavailable",
        // Any other reason.
        "runtime_disposed_before_delivery",
    ] as const)("keeps an ordinary row behind a head blocked as %s and reports that head", async (reason) => {
        const { ownerId, sessionId } = await createOwnerSession(`blocked-${reason}`);
        const head = `head-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await claimHeadThenBlock(ownerId, sessionId, head, reason);
        const headRow = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId, localId: head } },
            select: { updatedAt: true },
        });

        const result = await materialize(ownerId, sessionId);
        expect(result).toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: {
                localId: head,
                deliveryState: "blocked",
                blockedReason: reason,
                lastUpdatedAt: headRow.updatedAt.getTime(),
            },
        });
        if (!result.ok || result.didMaterialize || !result.blockingHead) throw new Error("expected a reported head");
        expect(result.blockingHead.ageSinceLastUpdateMs).toBeGreaterThanOrEqual(0);
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "blocked", deliveryBlockedReason: reason },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
    });

    it("keeps an ordinary row behind a blocked head whose stored reason is not a known reason", async () => {
        const { ownerId, sessionId } = await createOwnerSession("blocked-unknown-reason");
        const head = `head-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await claimHeadThenBlock(ownerId, sessionId, head, "delivery_outcome_uncertain");
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { deliveryBlockedReason: "reason_from_a_newer_server" },
        });

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: { localId: head, deliveryState: "blocked", blockedReason: "unknown" },
        });
        await expect(readRows(sessionId)).resolves.toMatchObject([
            { localId: head, deliveryState: "blocked" },
            { localId: next, deliveryState: null },
        ]);
    });

    it("keeps an ordinary row behind an external_handoff head and reports that head", async () => {
        const { ownerId, sessionId } = await createOwnerSession("external-handoff-head");
        const head = `handoff-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head, { deliveryMode: "external_handoff" });
        await enqueue(ownerId, sessionId, next);

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: { localId: head, deliveryState: "external_handoff" },
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "external_handoff", deliveryBlockedReason: null },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
    });

    it("never claims an ordinary row while the head is delivering", async () => {
        const { ownerId, sessionId } = await createOwnerSession("delivering-head");
        const head = `delivering-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: head },
        });

        // The current publisher rejoins its own unresolved claim; the later row stays queued.
        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: head },
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "delivering", deliveryBlockedReason: null },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
    });

    it("does not pass an unsupported_action head to reach a later blocked row, and reports the later row", async () => {
        const { ownerId, sessionId } = await createOwnerSession("unsupported-then-blocked");
        const unsupported = `unsupported-${randomUUID()}`;
        const blocked = `blocked-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, unsupported);
        await enqueue(ownerId, sessionId, blocked);
        await enqueue(ownerId, sessionId, next);
        await claimHeadThenBlock(ownerId, sessionId, unsupported, "unsupported_action");
        await claimHeadThenBlock(ownerId, sessionId, blocked, "provider_rejected_before_acceptance");

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: { localId: blocked, deliveryState: "blocked", blockedReason: "provider_rejected_before_acceptance" },
        });
        await expect(readRows(sessionId)).resolves.toMatchObject([
            { localId: unsupported, deliveryState: "blocked" },
            { localId: blocked, deliveryState: "blocked" },
            { localId: next, deliveryState: null },
        ]);
    });

    it.each([
        ["send_now", "active_unsteerable", "interrupt_and_send"],
        ["steer_now", "active_steerable", "steer"],
    ] as const)("still lets an explicit %s row bypass a blocked head", async (kind, foregroundState, providerAction) => {
        const { ownerId, sessionId } = await createOwnerSession(`explicit-${kind}`);
        const head = `head-${randomUUID()}`;
        const explicit = `explicit-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await claimHeadThenBlock(ownerId, sessionId, head, "provider_unavailable_before_acceptance");
        await enqueue(ownerId, sessionId, explicit, { requestedAction: { v: 1, kind } });

        await expect(materialize(ownerId, sessionId, foregroundState)).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: explicit, providerAction },
        });
        await expect(readRows(sessionId)).resolves.toMatchObject([
            { localId: head, deliveryState: "blocked", deliveryBlockedReason: "provider_unavailable_before_acceptance" },
            { localId: explicit, deliveryState: "delivering" },
        ]);
    });
    const readRawPayload = async (sessionId: string, localId: string) => await db.$queryRawUnsafe<Array<{
        contentHex: string;
        requestedActionHex: string;
    }>>(
        'SELECT hex(CAST("content" AS BLOB)) AS "contentHex", hex(CAST("requestedAction" AS BLOB)) AS "requestedActionHex" '
            + 'FROM "SessionPendingMessage" WHERE "sessionId" = ? AND "localId" = ?',
        sessionId,
        localId,
    );

    it("keeps a stored-block row's content and requested action byte for byte, advancing only its update time", async () => {
        const { ownerId, sessionId } = await createOwnerSession("unsupported-raw-bytes");
        const head = `raw-bytes-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        // Unusual key order, spacing and a non-ASCII character: any parse-and-reserialize of either
        // column would change these bytes.
        await db.$executeRawUnsafe(
            'UPDATE "SessionPendingMessage" SET "requestedAction" = ?, "content" = ? WHERE "sessionId" = ? AND "localId" = ?',
            '{"kind":  "future_action","v":1 , "note":"caf\u00e9 ü"}',
            '{"c":"cipher-raw-bytes",   "t":"encrypted"}',
            sessionId,
            head,
        );
        const rawBefore = await readRawPayload(sessionId, head);
        const rowBefore = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId, localId: head } },
            select: { updatedAt: true },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({ ok: true, didMaterialize: false });

        await expect(readRawPayload(sessionId, head)).resolves.toEqual(rawBefore);
        const rowAfter = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId, localId: head } },
            select: { deliveryState: true, deliveryBlockedReason: true, updatedAt: true },
        });
        expect(rowAfter).toMatchObject({ deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" });
        expect(rowAfter.updatedAt.getTime()).toBeGreaterThan(rowBefore.updatedAt.getTime());
    });

    it("never stores an unsupported_action block on a held head whose action is unparseable", async () => {
        const { ownerId, sessionId } = await createOwnerSession("malformed-held-blocked");
        const head = `held-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await claimHeadThenBlock(ownerId, sessionId, head, "provider_rejected_before_acceptance");
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        const countersBefore = await readCounters(sessionId);

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: { localId: head, deliveryState: "blocked", blockedReason: "provider_rejected_before_acceptance" },
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "blocked", deliveryBlockedReason: "provider_rejected_before_acceptance" },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
        await expect(readCounters(sessionId)).resolves.toEqual(countersBefore);
    });

    it("never stores an unsupported_action block on an external_handoff head whose action is unparseable", async () => {
        const { ownerId, sessionId } = await createOwnerSession("malformed-held-handoff");
        const head = `handoff-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head, { deliveryMode: "external_handoff" });
        await enqueue(ownerId, sessionId, next);
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        const countersBefore = await readCounters(sessionId);

        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "waiting_for_predecessor",
            blockingHead: { localId: head, deliveryState: "external_handoff" },
        });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "external_handoff", deliveryBlockedReason: null },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
        await expect(readCounters(sessionId)).resolves.toEqual(countersBefore);
    });

    it("never stores an unsupported_action block on a delivering head whose action is unparseable", async () => {
        const { ownerId, sessionId } = await createOwnerSession("malformed-held-delivering");
        const head = `delivering-${randomUUID()}`;
        const next = `next-${randomUUID()}`;
        await enqueue(ownerId, sessionId, head);
        await enqueue(ownerId, sessionId, next);
        await expect(materialize(ownerId, sessionId)).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: head } });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId: head } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        const countersBefore = await readCounters(sessionId);

        // The current publisher's rejoin of its own claim answers first, as before this change; it
        // cannot rebuild the frozen claim from an unparseable action.
        await expect(materialize(ownerId, sessionId)).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(readRows(sessionId)).resolves.toEqual([
            { localId: head, status: "queued", deliveryState: "delivering", deliveryBlockedReason: null },
            { localId: next, status: "queued", deliveryState: null, deliveryBlockedReason: null },
        ]);
        await expect(readCounters(sessionId)).resolves.toEqual(countersBefore);
    });
});
