import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { eventRouter } from "@/app/events/eventRouter";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

import { sessionUpdateHandler } from "./sessionUpdateHandler";

/**
 * The stored `unsupported_action` block through the real socket handler, publisher presence and
 * SQLite: what a runner's `pending-materialize-next` call commits, and which calls push a
 * `pending-changed` update to participants.
 */
describe("socket materialization past a raw unparseable head on SQLite", () => {
    let harness: LightSqliteHarness;
    let emitUpdate: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-unsupported-head-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => {
        harness.resetEnv();
        emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
    });
    afterEach(() => emitUpdate.mockRestore());
    afterAll(async () => await harness.close());

    const pendingChangedPushes = () => emitUpdate.mock.calls.filter(([update]) => (
        (update as { payload?: { body?: { t?: unknown } } }).payload?.body?.t === "pending-changed"
    ));

    async function setUpSession() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({
            data: {
                tag: `session-${randomUUID()}`,
                accountId: owner.id,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket({
            id: `runner-${randomUUID()}`,
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: { sessionId: session.id, machineId, proof: "machine-access-key" },
            },
        });
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        const registered = await presence.registerPublisher({
            socket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");
        sessionUpdateHandler(owner.id, socket as any, {
            connectionType: "session-scoped",
            socket,
            userId: owner.id,
            sessionId: session.id,
        } as any, { presence, binding });
        const materialize = async (extra: Record<string, unknown> = {}) => {
            const callback = vi.fn();
            await getSocketHandler(socket, "pending-materialize-next")({
                ...extra,
                sid: session.id,
                deliveryState: "provider",
                deliveryTiming: "after_foreground_ready",
                foregroundState: "ready",
            }, callback);
            expect(callback).toHaveBeenCalledTimes(1);
            return callback.mock.calls[0]?.[0] as Record<string, unknown>;
        };
        return { ownerId: owner.id, sessionId: session.id, materialize };
    }

    async function enqueueRawUnparseable(ownerId: string, sessionId: string, localId: string) {
        await enqueuePendingMessage({
            actorUserId: ownerId,
            sessionId,
            localId,
            ciphertext: `cipher-${localId}`,
            requestedAction: { v: 1, kind: "enqueue" },
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId, localId } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
    }

    const readState = async (sessionId: string) => ({
        session: await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        }),
        rows: await db.sessionPendingMessage.findMany({
            where: { sessionId },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: {
                localId: true,
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                requestedAction: true,
                content: true,
                updatedAt: true,
            },
        }),
    });

    it("stores the block once: a repeat call changes no row, counter or version and pushes nothing", async () => {
        const { ownerId, sessionId, materialize } = await setUpSession();
        const head = `raw-head-${randomUUID()}`;
        await enqueueRawUnparseable(ownerId, sessionId, head);
        const before = await readState(sessionId);

        await expect(materialize()).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: before.session.pendingVersion + 1,
        });
        expect(pendingChangedPushes()).toHaveLength(1);
        const afterFirst = await readState(sessionId);
        expect(afterFirst.rows).toMatchObject([
            { localId: head, deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
        ]);

        emitUpdate.mockClear();
        await expect(materialize()).resolves.toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: afterFirst.session.pendingVersion,
            deliveryState: { mode: "provider", unresolved: false },
        });
        expect(emitUpdate).not.toHaveBeenCalled();
        await expect(readState(sessionId)).resolves.toEqual(afterFirst);
    });

    it("commits the stored block under an error answer, pushes nothing, and returns the stored counters to a stale-version retry", async () => {
        const { ownerId, sessionId, materialize } = await setUpSession();
        const head = `raw-head-${randomUUID()}`;
        const next = `conflicting-next-${randomUUID()}`;
        await enqueueRawUnparseable(ownerId, sessionId, head);
        await enqueuePendingMessage({
            actorUserId: ownerId,
            sessionId,
            localId: next,
            ciphertext: `cipher-${next}`,
            requestedAction: { v: 1, kind: "enqueue" },
        });
        // A transcript row under the next row's localId with different content: claiming it
        // answers transcript-conflict after the head's block has been stored in the same transaction.
        await db.session.update({ where: { id: sessionId }, data: { seq: 1 } });
        await db.sessionMessage.create({
            data: {
                sessionId,
                seq: 1,
                localId: next,
                messageRole: "user",
                content: { t: "encrypted", c: "different-transcript-content" },
            },
        });
        const before = await readState(sessionId);
        expect(before.session).toMatchObject({ pendingCount: 2, pendingBlockedCount: 0 });

        await expect(materialize()).resolves.toEqual({ ok: false, error: "transcript-conflict" });
        expect(emitUpdate).not.toHaveBeenCalled();
        const after = await readState(sessionId);
        expect(after.session).toEqual({
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingVersion: before.session.pendingVersion + 1,
        });
        expect(after.rows).toMatchObject([
            { localId: head, deliveryState: "blocked", deliveryBlockedReason: "unsupported_action" },
            { localId: next, deliveryState: null },
        ]);

        // A runner still holding the old version learns the stored counters without any push.
        await expect(materialize({ expectedPendingVersion: before.session.pendingVersion })).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "pending_version_mismatch",
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingVersion: after.session.pendingVersion,
        });
        expect(emitUpdate).not.toHaveBeenCalled();
        await expect(readState(sessionId)).resolves.toEqual(after);
    });
});
