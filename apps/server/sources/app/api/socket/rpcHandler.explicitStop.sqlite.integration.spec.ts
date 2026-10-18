import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_ERROR_CODES, RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, triggerSocketHandler } from "../testkit/socketHarness";
import { rpcHandler } from "./rpcHandler";

describe("explicit machine stop RPC on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-explicit-stop-rpc-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({
            socket: {},
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected publisher registration");
        return { owner, machineId, session, presence };
    }

    async function callStop(params: Readonly<{
        targetResponse: unknown;
        beforeCall?: (seeded: Awaited<ReturnType<typeof seed>>) => Promise<void>;
        beforeResponse?: (seeded: Awaited<ReturnType<typeof seed>>) => Promise<void>;
    }>) {
        const seeded = await seed();
        await params.beforeCall?.(seeded);
        const method = `${seeded.machineId}:${RPC_METHODS.STOP_SESSION}`;
        const targetEmitWithAck = vi.fn(async () => {
            await params.beforeResponse?.(seeded);
            const isStopped = (
                params.targetResponse
                && typeof params.targetResponse === "object"
                && !Array.isArray(params.targetResponse)
                && (params.targetResponse as { status?: unknown }).status === "stopped"
            );
            return {
                v: 1,
                result: params.targetResponse,
                ...(isStopped
                    ? { acknowledgement: { kind: "session.stop", status: "stopped" } }
                    : {}),
            };
        });
        const target = createFakeSocket({
            id: "target-socket",
            data: { clientType: "machine-scoped", machineId: seeded.machineId },
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        });
        const caller = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            [seeded.owner.id, new Map([[method, target as unknown as Socket]])],
        ]);

        rpcHandler(
            seeded.owner.id,
            caller as unknown as Socket,
            new Map(),
            allRpcListeners,
            {
                io: {} as Server,
                redisRegistry: { enabled: false },
                sessionPublisherPresence: seeded.presence,
            },
        );
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: seeded.session.id,
            },
        }, callback);
        return { ...seeded, callback, targetEmitWithAck };
    }

    it("marks the exact session inactive only after the daemon proves it stopped", async () => {
        const result = await callStop({ targetResponse: { status: "stopped" } });

        expect(result.targetEmitWithAck).toHaveBeenCalledOnce();
        expect(result.targetEmitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method: `${result.machineId}:${RPC_METHODS.STOP_SESSION}`,
                params: "opaque-encrypted-stop-request",
                authorization: {
                    kind: "session.write",
                    sessionId: result.session.id,
                },
                transportResponseEnvelopeVersion: 1,
            },
        );
        expect(result.callback).toHaveBeenCalledWith({
            ok: true,
            result: { status: "stopped" },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true },
        })).resolves.toEqual({ active: false });
    });

    it("keeps the session active when physical termination is only requested", async () => {
        const result = await callStop({ targetResponse: { status: "requested" } });

        expect(result.callback).toHaveBeenCalledWith({
            ok: true,
            result: { status: "requested" },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });

    it.each([false, true])("forwards an authorized archived stop with active=%s and terminalizes its fence without unarchiving", async (active) => {
        const archivedAt = new Date("2026-10-18T01:00:00.000Z");
        const runtimeActivityObservedAt = BigInt(archivedAt.getTime());
        const result = await callStop({
            targetResponse: { status: "stopped" },
            beforeCall: async ({ session }) => {
                await db.session.update({
                    where: { id: session.id },
                    data: {
                        active, archivedAt,
                        runtimeActivityState: "unknown", runtimeActivityActiveCount: 0,
                        runtimeActivityObservedAt, runtimeActivityRevision: 7n,
                    },
                });
            },
        });

        expect(result.targetEmitWithAck).toHaveBeenCalledOnce();
        expect(result.callback).toHaveBeenCalledWith({ ok: true, result: { status: "stopped" } });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: {
                active: true, archivedAt: true, publisherGenerationLastActiveAt: true,
                runtimeActivityState: true, runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true, runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: false, archivedAt, publisherGenerationLastActiveAt: null,
            runtimeActivityState: "unknown", runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt, runtimeActivityRevision: 7n,
        });
    });

    it("retains the archived publisher fence when termination is only requested", async () => {
        const archivedAt = new Date("2026-10-18T01:00:00.000Z");
        const result = await callStop({
            targetResponse: { status: "requested" },
            beforeCall: async ({ session }) => {
                await db.session.update({ where: { id: session.id }, data: { active: false, archivedAt } });
            },
        });

        expect(result.targetEmitWithAck).toHaveBeenCalledOnce();
        expect(result.callback).toHaveBeenCalledWith({ ok: true, result: { status: "requested" } });
        const session = await db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true, archivedAt: true, lastActiveAt: true, publisherGenerationLastActiveAt: true },
        });
        expect(session).toEqual({ active: false, archivedAt, lastActiveAt: session.lastActiveAt, publisherGenerationLastActiveAt: session.lastActiveAt });
    });

    it("preserves archive when it occurs between stop capture and physical-stop acknowledgement", async () => {
        const archivedAt = new Date("2026-10-18T01:00:00.000Z");
        const result = await callStop({
            targetResponse: { status: "stopped" },
            beforeResponse: async ({ session }) => {
                await db.session.update({
                    where: { id: session.id },
                    data: { active: false, archivedAt },
                });
            },
        });

        expect(result.callback).toHaveBeenCalledWith({ ok: true, result: { status: "stopped" } });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true, archivedAt: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({ active: false, archivedAt, publisherGenerationLastActiveAt: null });
    });

    it("does not forward an archived stop after session-scoped machine access is revoked", async () => {
        const result = await callStop({
            targetResponse: { status: "stopped" },
            beforeCall: async ({ owner, machineId, session }) => {
                await db.session.update({
                    where: { id: session.id },
                    data: { active: false, archivedAt: new Date("2026-10-18T01:00:00.000Z") },
                });
                await db.accessKey.deleteMany({
                    where: { accountId: owner.id, machineId, sessionId: session.id },
                });
            },
        });

        expect(result.targetEmitWithAck).not.toHaveBeenCalled();
        expect(result.callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            errorCode: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
        }));
    });

    it("does not finalize an archived stop when machine access is revoked before acknowledgement", async () => {
        const archivedAt = new Date("2026-10-18T01:00:00.000Z");
        const result = await callStop({
            targetResponse: { status: "stopped" },
            beforeCall: async ({ session }) => {
                await db.session.update({ where: { id: session.id }, data: { active: false, archivedAt } });
            },
            beforeResponse: async ({ owner, machineId, session }) => {
                await db.accessKey.deleteMany({ where: { accountId: owner.id, machineId, sessionId: session.id } });
            },
        });

        expect(result.targetEmitWithAck).toHaveBeenCalledOnce();
        expect(result.callback).toHaveBeenCalledWith({ ok: false, error: "Session stop could not be finalized safely" });
        const session = await db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true, archivedAt: true, lastActiveAt: true, publisherGenerationLastActiveAt: true },
        });
        expect(session).toEqual({ active: false, archivedAt, lastActiveAt: session.lastActiveAt, publisherGenerationLastActiveAt: session.lastActiveAt });
    });

    it("does not close a successor publisher that registers while stop is in flight", async () => {
        let successorFence: Date | null = null;
        let seededPresence: ReturnType<typeof createSessionPublisherPresence> | null = null;
        let successorBinding: Readonly<{ accountId: string; machineId: string; sessionId: string }> | null = null;
        const seeded = await seed();
        seededPresence = seeded.presence;
        successorBinding = {
            accountId: seeded.owner.id,
            machineId: seeded.machineId,
            sessionId: seeded.session.id,
        };
        const method = `${seeded.machineId}:${RPC_METHODS.STOP_SESSION}`;
        const target = createFakeSocket({
            id: "target-socket",
            data: { clientType: "machine-scoped", machineId: seeded.machineId },
            timeout: vi.fn(() => ({
                emitWithAck: async () => {
                    const successor = await seededPresence!.registerPublisher({
                        socket: {},
                        binding: successorBinding!,
                        completeActivitySnapshot: { state: "active", activeCount: 1 },
                    });
                    if (successor.status !== "registered") throw new Error("expected successor registration");
                    successorFence = successor.committedFence;
                    return {
                        v: 1,
                        result: { status: "stopped" },
                        acknowledgement: { kind: "session.stop", status: "stopped" },
                    };
                },
            })),
        });
        const caller = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();

        rpcHandler(
            seeded.owner.id,
            caller as unknown as Socket,
            new Map(),
            new Map([[seeded.owner.id, new Map([[method, target as unknown as Socket]])]]),
            {
                io: {} as Server,
                redisRegistry: { enabled: false },
                sessionPublisherPresence: seeded.presence,
            },
        );
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: seeded.session.id,
            },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Session resumed while stop was in progress",
        });
        const stored = await db.session.findUniqueOrThrow({
            where: { id: seeded.session.id },
            select: { active: true, lastActiveAt: true },
        });
        expect(stored.active).toBe(true);
        expect(stored.lastActiveAt).toEqual(successorFence);
    });
});
