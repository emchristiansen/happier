import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSessionRelayAuthorizationCache } from "@/app/api/socket/sessionRelayAuthCache";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/eventRouter";

import { createSessionPublisherPresence } from "./sessionPublisherPresence";
import { expireSessionPublisherCandidates } from "./sessionPublisherPresenceTimeout";
import { runPresenceTimeoutTick } from "./timeout";
import { materializeNextPendingMessageForCurrentPublisher } from "@/app/session/pending/materializeNextPendingMessage";

describe("session publisher presence on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-publisher-presence-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => {
        harness.resetEnv();
        clearSessionRelayAuthorizationCache();
    });
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const fence = new Date("2026-07-13T12:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: fence,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
        await db.sessionShare.create({
            data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: participant.id, accessLevel: "view" },
        });
        return {
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            participantIds: [owner.id, participant.id].sort(),
            fence,
        };
    }

    it("serializes distinct same-socket registration intents and makes predecessor operations superseded", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime());
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = {};
        const firstPromise = presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        const duplicatePromise = presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
        expect(first.status).toBe("registered");
        expect(duplicate.status).toBe("registered");
        if (first.status !== "registered") throw new Error("expected registration");
        if (duplicate.status !== "registered") throw new Error("expected serialized registration");
        expect(duplicate.activity.projection).toMatchObject({ state: "idle", activeCount: 0 });
        expect(duplicate.committedFence.getTime()).toBeGreaterThan(first.committedFence.getTime());
        expect(first.committedFence.getTime()).toBe(seeded.fence.getTime() + 1);
        expect(first.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        now = new Date(duplicate.committedFence.getTime() + 10);
        const successor = {};
        const replacement = await presence.registerPublisher({
            socket: successor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(replacement.status).toBe("registered");
        await expect(presence.touchPublisher({ socket: predecessor })).resolves.toEqual({ status: "superseded" });
        await expect(presence.closePublisher({ socket: predecessor })).resolves.toEqual({ status: "superseded" });

        const activityBeforeClose = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { runtimeActivityState: true, runtimeActivityRevision: true, runtimeActivityObservedAt: true },
        });
        const closed = await presence.closePublisher({ socket: successor });
        expect(closed.status).toBe("closed");
        if (closed.status !== "closed") throw new Error("expected close");
        expect(closed.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        await expect(presence.closePublisher({ socket: successor })).resolves.toEqual(closed);
        const activityAfterClose = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { runtimeActivityState: true, runtimeActivityRevision: true, runtimeActivityObservedAt: true },
        });
        expect(activityAfterClose).toMatchObject({
            runtimeActivityState: "unknown",
            runtimeActivityRevision: activityBeforeClose.runtimeActivityRevision + 1n,
        });
        expect(activityAfterClose.runtimeActivityObservedAt).not.toEqual(activityBeforeClose.runtimeActivityObservedAt);
    });

    it("expires a queued current-publisher action before admission and never starts it later", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstAction = presence.runAsCurrentPublisher({
            socket,
            binding: seeded.binding,
            action: async () => await firstGate,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        const secondActionBody = vi.fn(async () => "started");
        type DeadlineBoundRun = <T>(params: Readonly<{
            socket: object;
            binding: typeof seeded.binding;
            deadlineAtMs?: number;
            action: () => Promise<T>;
        }>) => Promise<unknown>;
        const secondAction = (presence.runAsCurrentPublisherInTx as DeadlineBoundRun)({
            socket,
            binding: seeded.binding,
            deadlineAtMs: Date.now() + 25,
            action: secondActionBody,
        });
        let observedSettlement: Readonly<{ status: "fulfilled"; value: unknown }> | Readonly<{ status: "rejected"; reason: unknown }> | null = null;
        void secondAction.then(
            (value) => { observedSettlement = { status: "fulfilled", value }; },
            (reason: unknown) => { observedSettlement = { status: "rejected", reason }; },
        );

        await new Promise((resolve) => setTimeout(resolve, 50));
        const settlementAtDeadline = observedSettlement;

        releaseFirst();
        await Promise.allSettled([firstAction, secondAction]);
        expect(settlementAtDeadline).toMatchObject({
            status: "rejected",
            reason: { name: "LockAdmissionDeadlineExceededError" },
        });
        expect(secondActionBody).not.toHaveBeenCalled();
    });

    it("re-offers inherited provider delivery before successor publisher authority becomes usable", async () => {
        const seeded = await seed();
        await db.sessionPendingMessage.createMany({
            data: [{
                sessionId: seeded.binding.sessionId,
                authorAccountId: seeded.binding.accountId,
                localId: `inherited-action-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: "send",
                status: "queued",
                deliveryState: "delivering",
                position: 1,
            }, {
                sessionId: seeded.binding.sessionId,
                authorAccountId: seeded.binding.accountId,
                localId: `inherited-actionless-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext-actionless" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: null,
                status: "queued",
                deliveryState: "delivering",
                position: 2,
            }],
        });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { pendingCount: 2 },
        });
        const presence = createSessionPublisherPresence({
            now: () => new Date(seeded.fence.getTime() + 10),
        });

        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });

        expect(registered.status).toBe("registered");
        const rows = await db.sessionPendingMessage.findMany({
            where: { sessionId: seeded.binding.sessionId },
            orderBy: { position: "asc" },
        });
        expect(rows).toHaveLength(4);
        expect(rows.slice(0, 2)).toEqual([
            expect.objectContaining({ status: "discarded", discardedReason: "resent_as_new" }),
            expect.objectContaining({ status: "discarded", discardedReason: "resent_as_new" }),
        ]);
        for (const row of rows.slice(2)) {
            expect(row).toMatchObject({ status: "queued", deliveryState: null, providerAction: null, requestedAction: { v: 1, kind: "enqueue" } });
            expect(row.position).toBeGreaterThan(2);
        }
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true, active: true },
        })).resolves.toEqual({ pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 2, active: true });
        if (registered.status !== "registered") throw new Error("expected registration");
        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: seeded.binding.accountId,
            sessionId: seeded.binding.sessionId,
            trustedPublisherFence: { ...seeded.binding, committedFence: registered.committedFence },
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: rows[2].localId, providerAction: "send" } });
    });

    it("recovers due blocked and external-handoff rows at turnover without resending terminal or fresh refusals", async () => {
        const seeded = await seed();
        const now = new Date(seeded.fence.getTime() + 120_000);
        const dueAt = new Date(now.getTime() - 60_000);
        const reasons = ["delivery_outcome_uncertain", "ambiguous_terminal_delivery", "unknown", "runtime_disposed_before_delivery", "attempt_expired_before_write", "steering_unavailable",
            "provider_rejected_before_acceptance", "provider_unavailable_before_acceptance", "terminal_host_unreachable", "runtime_config_blocked", "terminal_composer_draft"];
        await db.sessionPendingMessage.createMany({ data: [
            ...reasons.map((reason, index) => ({
                sessionId: seeded.binding.sessionId, authorAccountId: seeded.binding.accountId,
                localId: reason, content: { t: "encrypted" as const, c: reason }, requestedAction: { v: 1, kind: "send_now" },
                position: index + 1, status: "queued" as const, deliveryState: "blocked", deliveryBlockedReason: reason, updatedAt: dueAt,
            })),
            { sessionId: seeded.binding.sessionId, authorAccountId: seeded.binding.accountId, localId: "external",
                content: { t: "encrypted", c: "handoff" }, requestedAction: { v: 1, kind: "enqueue" },
                position: 12, status: "queued" as const, deliveryState: "external_handoff", updatedAt: dueAt },
            { sessionId: seeded.binding.sessionId, authorAccountId: seeded.binding.accountId, localId: "terminal",
                content: { t: "encrypted", c: "terminal" }, requestedAction: { v: 1, kind: "enqueue" },
                position: 13, status: "queued" as const, deliveryState: "blocked", deliveryBlockedReason: "unsupported_action", updatedAt: dueAt },
            { sessionId: seeded.binding.sessionId, authorAccountId: seeded.binding.accountId, localId: "fresh",
                content: { t: "encrypted", c: "fresh" }, requestedAction: { v: 1, kind: "enqueue" },
                position: 14, status: "queued" as const, deliveryState: "blocked", deliveryBlockedReason: "runtime_config_blocked", updatedAt: now },
        ] });
        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { pendingCount: 14, pendingBlockedCount: 13 } });
        const result = await createSessionPublisherPresence({ now: () => now }).registerPublisher({
            socket: {}, binding: seeded.binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(result.status).toBe("registered");
        await expect(db.sessionPendingMessage.count({ where: { sessionId: seeded.binding.sessionId, discardedReason: "resent_as_new" } })).resolves.toBe(12);
        const replacements = await db.sessionPendingMessage.findMany({ where: { sessionId: seeded.binding.sessionId, status: "queued" as const, deliveryState: null } });
        expect(replacements).toHaveLength(12);
        for (const row of replacements) expect(row).toMatchObject({ requestedAction: { v: 1, kind: "enqueue" }, providerAction: null });
        await expect(db.sessionPendingMessage.findMany({ where: { sessionId: seeded.binding.sessionId, deliveryState: "blocked" }, orderBy: { position: "asc" }, select: { localId: true } }))
            .resolves.toEqual([{ localId: "terminal" }, { localId: "fresh" }]);
        await expect(db.session.findUniqueOrThrow({ where: { id: seeded.binding.sessionId }, select: { pendingCount: true, pendingBlockedCount: true } }))
            .resolves.toEqual({ pendingCount: 14, pendingBlockedCount: 2 });
    });

    it("keeps a newer server instance's fence and baseline when the previous instance closes or times out", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const firstServer = createSessionPublisherPresence({ now: () => now });
        const secondServer = createSessionPublisherPresence({ now: () => now });
        const firstSocket = {};
        const secondSocket = {};

        const first = await firstServer.registerPublisher({
            socket: firstSocket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected first server registration");

        now = new Date(first.committedFence.getTime() + 10);
        const replacement = await secondServer.registerPublisher({
            socket: secondSocket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (replacement.status !== "registered") throw new Error("expected second server replacement registration");

        await expect(firstServer.closePublisher({ socket: firstSocket })).resolves.toEqual({ status: "superseded" });
        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: first.committedFence }],
            observedBefore: new Date(replacement.committedFence.getTime() + 1),
        })).resolves.toEqual([{ status: "stale", sessionId: seeded.binding.sessionId }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: replacement.committedFence,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
        });
    });

    it.each([
        { state: "active", activeCount: 1 },
        { state: "idle", activeCount: 0 },
    ] as const)("rechecks an in-flight legacy unknown registration before publishing $state without a second reachability fence", async (completeSnapshot) => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });
        const socket = {};

        const legacyRegistration = presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });
        const publication = presence.publishSnapshot({
            socket,
            binding: seeded.binding,
            completeSnapshot,
        });
        const [registered, published] = await Promise.all([legacyRegistration, publication]);

        expect(registered.status).toBe("registered");
        if (registered.status !== "registered") throw new Error("expected legacy registration");
        expect(published.status).toBe("applied");
        if (published.status !== "applied") throw new Error("expected Activity-only publication");
        expect(published).not.toHaveProperty("activeAt");
        expect(published.projection).toMatchObject(completeSnapshot);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: registered.committedFence,
            runtimeActivityState: completeSnapshot.state,
            runtimeActivityActiveCount: completeSnapshot.activeCount,
        });
    });

    it("expires only an exact scanned fence and leaves Activity byte-identical", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const activity = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
                runtimeActivityObservedAt: true,
            },
        });
        now = new Date(registered.committedFence.getTime() + 20);
        const expired = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
            observedBefore: now,
        });
        expect(expired[0]?.status).toBe("expired");
        if (expired[0]?.status !== "expired") throw new Error("expected expiration");
        expect(expired[0].participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        expect(await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
                runtimeActivityObservedAt: true,
            },
        })).toEqual(activity);
    });

    it("recovers the same still-open publisher after timeout without changing Activity or reviving a replaced socket", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const activityBeforeTimeout = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });

        const [expired] = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
            observedBefore: new Date(registered.committedFence.getTime() + 1),
        });
        expect(expired?.status).toBe("expired");

        now = new Date(registered.committedFence.getTime() + 20);
        const recovered = await presence.touchPublisher({ socket });
        expect(recovered.status).toBe("touched");
        if (recovered.status !== "touched") throw new Error("expected same-socket timeout recovery");
        expect(recovered.committedFence.getTime()).toBeGreaterThan(registered.committedFence.getTime());
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: recovered.committedFence,
            ...activityBeforeTimeout,
        });

        now = new Date(recovered.committedFence.getTime() + 20);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected replacement registration");
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
    });

    it("writes unknown when the exact still-current socket disconnects after timeout", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
            observedBefore: new Date(registered.committedFence.getTime() + 1),
        });

        const disconnected = await presence.forgetDisconnectedPublisher({ socket });
        expect(disconnected.status).toBe("applied");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: registered.committedFence,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 2n,
        });
    });

    it.each([
        { initial: { state: "idle", activeCount: 0 } as const, expectedState: "idle", expectedRevision: 1n },
        { initial: { state: "active", activeCount: 1 } as const, expectedState: "unknown", expectedRevision: 2n },
    ])("clean close preserves only a durably published idle projection ($expectedState)", async ({ initial, expectedState, expectedRevision }) => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: initial,
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const closed = await presence.closePublisher({ socket });
        expect(closed.status).toBe("closed");
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await presence.forgetDisconnectedPublisher({ socket });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: expectedState,
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: expectedRevision,
        });
    });

    it("closes the exact active publisher after an explicit machine stop proves physical termination", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        expect(captured.status).toBe("captured");
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        const closed = await presence.finalizeExplicitMachineStop({ target: captured.target });
        expect(closed.status).toBe("closed");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: registered.committedFence,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
        });

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: "already_inactive" });
    });

    it("reports unavailable machine control when the session is not bound to that machine", async () => {
        const seeded = await seed();
        await db.accessKey.deleteMany({
            where: {
                accountId: seeded.binding.accountId,
                machineId: seeded.binding.machineId,
                sessionId: seeded.binding.sessionId,
            },
        });

        const presence = createSessionPublisherPresence();
        await expect(presence.captureExplicitMachineStop({ binding: seeded.binding })).resolves.toEqual({
            status: "rejected",
            reason: "machine_control_unavailable",
        });
    });

    it("lets only explicit stop terminalize an archived publisher without restoring publication rights", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const archivedAt = new Date("2026-10-18T01:00:00.000Z");
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { active: false, archivedAt },
        });

        await expect(presence.closePublisher({ socket })).resolves.toEqual({ status: "rejected", reason: "archived" });
        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        expect(captured.status).toBe("captured");
        if (captured.status !== "captured") throw new Error("expected archived-stop capture");
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: "already_inactive" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { archivedAt: true, active: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({ archivedAt, active: false, publisherGenerationLastActiveAt: null });

        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: null } });
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
    });

    it("does not let an archived stop close a successor publisher after unarchive", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const first = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected registration");
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { active: false, archivedAt: new Date("2026-10-18T01:00:00.000Z") },
        });
        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected archived-stop capture");
        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: null } });
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, archivedAt: true, lastActiveAt: true, publisherGeneration: true },
        })).resolves.toEqual({
            active: true,
            archivedAt: null,
            lastActiveAt: successor.committedFence,
            publisherGeneration: successor.publisherGeneration,
        });
    });

    it("keeps explicit-stop authority when the same publisher heartbeats before stop proof arrives", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        if (touched.status !== "touched") throw new Error("expected same-publisher heartbeat");

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toMatchObject({
            status: "closed",
            activeAt: touched.committedFence,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: touched.committedFence,
        });
    });

    it("does not let a stopped publisher heartbeat itself active again", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toMatchObject({
            status: "closed",
        });

        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: registered.committedFence,
        });
    });

    it("terminalizes a timed-out publisher when explicit stop proof arrives", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");
        await runPresenceTimeoutTick({
            sessionTimeoutMs: 1,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 1,
        });

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toEqual({
            status: "already_inactive",
        });
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toEqual({
            status: "already_inactive",
        });
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({
            active: false,
            publisherGenerationLastActiveAt: null,
        });
    });

    it.each([false, true])("keeps an exact-fence fallback for older-server publishers with archived=%s", async (archived) => {
        const unchanged = await seed();
        const presence = createSessionPublisherPresence();
        const archivedAt = archived ? new Date("2026-10-18T01:00:00.000Z") : null;
        await db.session.update({
            where: { id: unchanged.binding.sessionId },
            data: { active: true, archivedAt },
        });
        const captured = await presence.captureExplicitMachineStop({ binding: unchanged.binding });
        expect(captured).toMatchObject({
            status: "captured",
            target: {
                authority: { kind: "legacy-heartbeat", committedFence: unchanged.fence },
            },
        });
        if (captured.status !== "captured") throw new Error("expected legacy capture");
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toMatchObject({
            status: "closed",
        });

        const advanced = await seed();
        await db.session.update({
            where: { id: advanced.binding.sessionId },
            data: { active: true, archivedAt },
        });
        const staleCapture = await presence.captureExplicitMachineStop({ binding: advanced.binding });
        if (staleCapture.status !== "captured") throw new Error("expected legacy capture");
        await db.session.update({
            where: { id: advanced.binding.sessionId },
            data: { lastActiveAt: new Date(advanced.fence.getTime() + 1) },
        });
        await expect(presence.finalizeExplicitMachineStop({ target: staleCapture.target })).resolves.toEqual({
            status: "superseded",
        });
    });

    it("does not let a completed generation stop close a later legacy-server publisher", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toMatchObject({
            status: "closed",
        });

        const legacySuccessorFence = new Date(registered.committedFence.getTime() + 10);
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: {
                active: true,
                lastActiveAt: legacySuccessorFence,
                runtimeActivityState: "idle",
                runtimeActivityActiveCount: 0,
            },
        });

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toEqual({
            status: "superseded",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: legacySuccessorFence,
            runtimeActivityState: "idle",
        });
    });

    it("does not let a completed explicit stop close a successor publisher that registered meanwhile", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const first = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected first registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        now = new Date(first.committedFence.getTime() + 10);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toEqual({
            status: "superseded",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: successor.committedFence,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
        });
    });

    it("routes the production timeout through exact-fence expiry and advances every participant cursor", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const before = await db.account.findMany({
            where: { id: { in: seeded.participantIds } },
            select: { id: true, seq: true },
            orderBy: { id: "asc" },
        });

        await runPresenceTimeoutTick({
            sessionTimeoutMs: 1,
            machineTimeoutMs: 10 * 60 * 1000,
            tickMs: 1,
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: false });
        const after = await db.account.findMany({
            where: { id: { in: seeded.participantIds } },
            select: { id: true, seq: true },
            orderBy: { id: "asc" },
        });
        expect(after).toEqual(before.map((account) => ({ ...account, seq: account.seq + 1 })));
    });

    it("re-emits the exact waiting activation hint after the active-to-inactive timeout CAS", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const requestId = `pending-${randomUUID()}`;
        const requestedAt = new Date(registered.committedFence.getTime() + 1);
        await db.sessionPendingMessage.create({
            data: {
                sessionId: seeded.binding.sessionId,
                localId: requestId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                requestedAction: { v: 1, kind: "send_now" },
                status: "queued",
                position: 1,
                authorAccountId: seeded.binding.accountId,
            },
        });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: {
                pendingCount: 1,
                pendingVersion: 1,
                pendingActivationRequestId: requestId,
                pendingActivationRequestedAt: requestedAt,
                pendingActivationStatus: "waiting",
            },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});

        await runPresenceTimeoutTick({ sessionTimeoutMs: 1, machineTimeoutMs: 600_000, tickMs: 1 });

        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: seeded.binding.accountId,
            recipientFilter: { type: "user-machine-scoped-only" },
            payload: expect.objectContaining({
                body: expect.objectContaining({ pendingActivationRequestId: requestId }),
            }),
        }));
    });

    it("projects unknown only for the exact still-current disconnected registration", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const predecessor = {};
        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected registration");
        const successor = {};
        const replacement = await presence.registerPublisher({
            socket: successor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (replacement.status !== "registered") throw new Error("expected replacement");

        await presence.forgetDisconnectedPublisher({ socket: predecessor });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({ runtimeActivityState: "active", runtimeActivityRevision: 1n });

        const disconnected = await presence.forgetDisconnectedPublisher({ socket: successor });
        expect(disconnected.status).toBe("applied");
        if (disconnected.status !== "applied") throw new Error("expected current disconnect projection");
        expect(disconnected.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({ active: true, runtimeActivityState: "unknown", runtimeActivityRevision: 2n });
    });

    it("restores the successor baseline after the exact-current predecessor disconnect commits unknown", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = {};
        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected registration");

        const disconnected = await presence.forgetDisconnectedPublisher({ socket: predecessor });
        expect(disconnected.status).toBe("applied");
        now = new Date(first.committedFence.getTime() + 10);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(successor.status).toBe("registered");
        if (successor.status !== "registered") throw new Error("expected successor registration");
        expect(successor.committedFence.getTime()).toBeGreaterThan(first.committedFence.getTime());
        expect(successor.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: successor.committedFence,
            runtimeActivityState: "idle",
            runtimeActivityRevision: 3n,
        });
    });

    it("extends a live publisher without consuming account change cursors", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const readChangeState = async () => ({
            accounts: await db.account.findMany({
                where: { id: { in: seeded.participantIds } },
                select: { id: true, seq: true },
                orderBy: { id: "asc" },
            }),
            changes: await db.accountChange.findMany({
                where: { kind: "session", entityId: seeded.binding.sessionId },
                select: { accountId: true, cursor: true, changedAt: true },
                orderBy: { accountId: "asc" },
            }),
        });
        const beforeTouch = await readChangeState();

        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        if (touched.status !== "touched") throw new Error("expected touch");

        // A steady-state liveness tick is not a content change: it must not allocate an account
        // cursor or rewrite the coalesced change row. Publishing it through `Account.seq` made every
        // heartbeat a write to a row shared by every session of the account, and forced every client
        // to treat a liveness tick as a session refresh.
        await expect(readChangeState()).resolves.toEqual(beforeTouch);
        // The live push fanout must still reach every participant.
        expect(touched.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: touched.committedFence,
            publisherGenerationLastActiveAt: touched.committedFence,
        });
    });

    it("returns an unregistered touch and rejects stale timeout after terminal close", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "unregistered" });

        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const closed = await presence.closePublisher({ socket });
        expect(closed.status).toBe("closed");
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });

        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
            observedBefore: new Date(registered.committedFence.getTime() + 1),
        })).resolves.toEqual([{ status: "stale", sessionId: seeded.binding.sessionId }]);
    });

    it("touches and closes only the exact authorized fence, with full cursors and retry after revoked access", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        expect(touched.status).toBe("touched");
        if (touched.status !== "touched") throw new Error("expected touch");
        expect(touched.committedFence.getTime()).toBeGreaterThan(registered.committedFence.getTime());
        expect(touched.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: new Date() } });
        await expect(presence.closePublisher({ socket })).resolves.toEqual({
            status: "rejected",
            reason: "unauthorized",
        });
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: null } });

        const activityBeforeClose = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });
        const closed = await presence.closePublisher({ socket });
        expect(closed.status).toBe("closed");
        if (closed.status !== "closed") throw new Error("expected close after access restoration");
        expect(closed.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        const activityAfterClose = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });
        expect(activityAfterClose).toMatchObject({
            active: false,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: activityBeforeClose.runtimeActivityRevision + 1n,
        });
        expect(activityAfterClose.runtimeActivityObservedAt).not.toEqual(activityBeforeClose.runtimeActivityObservedAt);
    });

    it("gives unregistered disconnect and stale timeout zero authority", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence();
        await expect(presence.forgetDisconnectedPublisher({ socket: {} })).resolves.toEqual({ status: "unregistered" });
        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: seeded.fence }],
            observedBefore: new Date(seeded.fence.getTime() + 1),
        })).resolves.toEqual([{ status: "stale", sessionId: seeded.binding.sessionId }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: seeded.fence,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: 0n,
        });
    });

    it("rejects missing, revoked, archived, and revision-overflow registration without fanout or reachability", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence();
        await expect(presence.registerPublisher({
            socket: {},
            binding: { ...seeded.binding, sessionId: "missing-session" },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "not_found" });

        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: new Date() } });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: null } });

        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: new Date() } });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "archived" });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { archivedAt: null, runtimeActivityRevision: BigInt(Number.MAX_SAFE_INTEGER) },
        });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "revision_overflow" });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: {
                runtimeActivityRevision: 0n,
                publisherGeneration: 9_223_372_036_854_775_807n,
            },
        });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "revision_overflow" });

        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGeneration: true },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: seeded.fence,
            publisherGeneration: 9_223_372_036_854_775_807n,
        });
        const participants = await db.account.findMany({
            where: { id: { in: seeded.participantIds } },
            select: { seq: true },
        });
        expect(participants.every(({ seq }) => seq === 0)).toBe(true);
    });

    it("retries rejected registration and applies later distinct intent on the same socket", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 1 },
        })).rejects.toThrow();
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: new Date() } });
        const socket = {};
        await expect(presence.registerPublisher({
            socket, binding: seeded.binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: null } });

        const registered = await presence.registerPublisher({
            socket, binding: seeded.binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");
        if (registered.status !== "registered") throw new Error("expected registration after authorization repair");
        expect(registered.committedFence.getTime()).toBe(seeded.fence.getTime() + 1);
        expect(registered.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        const applied = await presence.registerPublisher({
            socket, binding: seeded.binding, completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(applied.status).toBe("registered");
        if (applied.status !== "registered") throw new Error("expected later registration intent");
        expect(applied.activity.projection).toMatchObject({ state: "active", activeCount: 1 });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { runtimeActivityState: true, runtimeActivityRevision: true, lastActiveAt: true },
        })).resolves.toEqual({
            runtimeActivityState: "active",
            runtimeActivityRevision: 2n,
            lastActiveAt: applied.committedFence,
        });

        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: new Date() } });
        await expect(presence.registerPublisher({
            socket: {}, binding: seeded.binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "archived" });
    });


    it("retires an exited runner incarnation only while its registration still holds the current publisher generation", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime());
        const reportingServer = createSessionPublisherPresence({ now: () => now });
        const otherServer = createSessionPublisherPresence({ now: () => now });
        const exitedRunner = {};
        reportingServer.bindPublisherIncarnation({ socket: exitedRunner, publisherIncarnationId: "incarnation-a" });
        const exited = await reportingServer.registerPublisher({
            socket: exitedRunner,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (exited.status !== "registered") throw new Error("expected registration");

        // The successor registers on another server process, so the reporting server's record of
        // incarnation A is stale; only the generation check inside the close transaction sees it.
        now = new Date(exited.committedFence.getTime() + 10);
        const successorRunner = {};
        otherServer.bindPublisherIncarnation({ socket: successorRunner, publisherIncarnationId: "incarnation-b" });
        const successor = await otherServer.registerPublisher({
            socket: successorRunner,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");
        expect(successor.publisherGeneration).not.toBe(exited.publisherGeneration);
        const before = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGeneration: true, publisherGenerationLastActiveAt: true },
        });

        await expect(reportingServer.retireExitedPublisher({
            binding: seeded.binding,
            publisherIncarnationId: "incarnation-a",
        })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGeneration: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual(before);
        expect(before).toMatchObject({ active: true, publisherGeneration: successor.publisherGeneration });

        const retired = await otherServer.retireExitedPublisher({
            binding: seeded.binding,
            publisherIncarnationId: "incarnation-b",
        });
        expect(retired.status).toBe("closed");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({ active: false, publisherGenerationLastActiveAt: null });
    });

    it("rejects a predecessor's exit report once a successor without an incarnation has registered", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime());
        const presence = createSessionPublisherPresence({ now: () => now });
        const exitedRunner = {};
        presence.bindPublisherIncarnation({ socket: exitedRunner, publisherIncarnationId: "incarnation-a" });
        const exited = await presence.registerPublisher({
            socket: exitedRunner,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (exited.status !== "registered") throw new Error("expected registration");
        now = new Date(exited.committedFence.getTime() + 10);
        const legacySuccessor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(legacySuccessor.status).toBe("registered");

        await expect(presence.retireExitedPublisher({
            binding: seeded.binding,
            publisherIncarnationId: "incarnation-a",
        })).resolves.toEqual({ status: "rejected", reason: "unmatched" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });

});
