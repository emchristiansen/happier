import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { auth } from "@/app/auth/auth";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { emitPendingChanged } from "@/app/session/pending/publishPendingMutation";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

// Wire names are the released contract between the daemon and the relay server.
const MACHINE_SESSION_RUNNER_EXITED_EVENT = "machine-session-runner-exited";
const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = "session-runtime-activity-snapshot";

type ClientSocket = ReturnType<typeof ioClient>;

function connect(socket: ClientSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
        socket.connect();
    });
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
}

describe("startSocket machine-reported runner exit", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-runner-exit-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    async function startServer() {
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }
        return { app, url: `http://127.0.0.1:${port}` };
    }

    async function seedMachineSession(machineId: string) {
        const account = await db.account.create({
            data: { publicKey: `pk-${machineId}-${Date.now()}` },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `t-${machineId}-${Date.now()}`,
                accountId: account.id,
                encryptionMode: "e2ee",
                metadata: "{}",
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        return { accountId: account.id, sessionId: session.id, token: await auth.createToken(account.id) };
    }

    function machineSocket(url: string, token: string, machineId: string): ClientSocket {
        return ioClient(url, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId,
                runtimeId: `runtime-${machineId}`,
                startupSource: "manual",
                serviceManaged: false,
            },
        });
    }

    function runnerSocket(params: Readonly<{
        url: string;
        token: string;
        machineId: string;
        sessionId: string;
        publisherIncarnationId: string;
    }>): ClientSocket {
        return ioClient(params.url, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token: params.token,
                clientType: "session-scoped",
                sessionId: params.sessionId,
                machineId: params.machineId,
                publisherIncarnationId: params.publisherIncarnationId,
            },
        });
    }

    async function readPresence(sessionId: string) {
        return await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                publisherGeneration: true,
                publisherGenerationLastActiveAt: true,
                runtimeActivityState: true,
                latestTurnId: true,
                latestTurnStatus: true,
                latestTurnStatusObservedAt: true,
            },
        });
    }

    /** Connects a runner socket and registers it as the session's publisher; returns the live socket. */
    async function registerRunner(params: Parameters<typeof runnerSocket>[0]): Promise<ClientSocket> {
        const runner = runnerSocket(params);
        await connect(runner);
        const ack = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, {
            sessionId: params.sessionId,
            mutationId: `registration-${params.publisherIncarnationId}`,
            snapshot: { state: "active", activeCount: 1 },
        });
        expect(ack).toMatchObject({ status: "applied", sessionId: params.sessionId });
        return runner;
    }

    /** Kills a runner's connection the way a dead process does and waits for the server to forget it. */
    async function killRunner(runner: ClientSocket, sessionId: string): Promise<void> {
        runner.close();
        // The server forgets the dead publisher on disconnect, but `active` stays true.
        await waitFor(async () => (await readPresence(sessionId)).runtimeActivityState === "unknown",
            "Expected the server to process the runner disconnect");
        await expect(readPresence(sessionId)).resolves.toMatchObject({ active: true });
    }

    async function beginTurn(accountId: string, sessionId: string, turnId: string): Promise<void> {
        await expect(applySessionTurnMutation({
            actorUserId: accountId,
            mutation: {
                v: 1,
                sessionId,
                mutationId: `begin-${turnId}`,
                action: "begin",
                turnId,
                observedAt: Date.now() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
    }

    it("stops reading active once the session's machine reports that its runner exited", async () => {
        const machineId = "m-runner-exit";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);

        try {
            const runnerA = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            });
            await killRunner(runnerA, seeded.sessionId);
            await connect(daemon);

            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });

            expect(ack).toEqual({ status: "closed", sessionId: seeded.sessionId });
            await expect(readPresence(seeded.sessionId)).resolves.toMatchObject({
                active: false,
                publisherGenerationLastActiveAt: null,
            });

            const repeated = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });
            expect(repeated).toEqual({ status: "already_inactive", sessionId: seeded.sessionId });
        } finally {
            daemon.close();
            await app.close();
        }
    }, 30_000);

    it("wakes the waiting activation request when the exited runner's retirement makes the session inactive", async () => {
        const machineId = "m-runner-exit-wake";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);
        const activationHints: string[] = [];
        daemon.on("update", (update: { body?: { t?: unknown; sessionId?: unknown; pendingActivationRequestId?: unknown } }) => {
            const body = update?.body;
            if (
                body?.t === "pending-changed"
                && body.sessionId === seeded.sessionId
                && typeof body.pendingActivationRequestId === "string"
            ) {
                activationHints.push(body.pendingActivationRequestId);
            }
        });

        try {
            // Runner A dies without a graceful close; the session still reads active at A's last fence.
            const runnerA = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            });
            await killRunner(runnerA, seeded.sessionId);
            await connect(daemon);

            // Before A's exit report arrives, the user sends now. The route arms the session's activation
            // authorization and wakes the daemon once.
            const requestId = `pending-${randomUUID()}`;
            const enqueued = await enqueuePendingMessage({
                actorUserId: seeded.accountId,
                sessionId: seeded.sessionId,
                localId: requestId,
                ciphertext: "cipher-send-now",
                messageRole: "user",
                requestedAction: { v: 1, kind: "send_now" },
            });
            if (!enqueued.ok || enqueued.terminal === true || enqueued.suppressed === true) {
                throw new Error(`Expected the send-now request to be queued: ${JSON.stringify(enqueued)}`);
            }
            expect(enqueued.activationTarget).toEqual({ accountId: seeded.accountId, requestId });
            await emitPendingChanged({
                sessionId: seeded.sessionId,
                changedByAccountId: seeded.accountId,
                pendingCount: enqueued.pendingCount,
                pendingBlockedCount: enqueued.pendingBlockedCount,
                pendingVersion: enqueued.pendingVersion,
                meaningfulActivityAt: enqueued.didWrite ? enqueued.meaningfulActivityAt : undefined,
                participantCursors: enqueued.participantCursors,
                activationTarget: enqueued.activationTarget!,
            });
            await waitFor(async () => activationHints.length === 1, "Expected the daemon to receive the initial activation hint");

            // The daemon's first activation attempt fails transiently (its first session fetch throws), so
            // it keeps the durable authorization and waits for the next wake. Then A's exit report lands.
            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });
            expect(ack).toEqual({ status: "closed", sessionId: seeded.sessionId });
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true, pendingActivationRequestId: true, pendingActivationStatus: true },
            })).resolves.toEqual({ active: false, pendingActivationRequestId: requestId, pendingActivationStatus: "waiting" });

            // The presence timeout no longer selects this inactive row, so the retirement itself must
            // re-deliver the exact waiting request's wake on the daemon's existing connection.
            await waitFor(async () => activationHints.length === 2,
                "Expected the waiting activation request to be woken again after the exited runner was retired");
            expect(activationHints).toEqual([requestId, requestId]);
        } finally {
            daemon.close();
            await app.close();
        }
    }, 30_000);

    it("retires a runner that re-registered after a reconnect by its latest registration", async () => {
        const machineId = "m-runner-reconnect";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);

        try {
            const runnerParams = {
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            } as const;
            const firstConnection = await registerRunner(runnerParams);
            await killRunner(firstConnection, seeded.sessionId);
            const reconnected = await registerRunner(runnerParams);
            await killRunner(reconnected, seeded.sessionId);
            await connect(daemon);

            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });

            expect(ack).toEqual({ status: "closed", sessionId: seeded.sessionId });
            await expect(readPresence(seeded.sessionId)).resolves.toMatchObject({ active: false });
        } finally {
            daemon.close();
            await app.close();
        }
    }, 30_000);

    it("leaves a successor runner, its fence and its turn intact when the predecessor's exit report arrives late", async () => {
        const machineId = "m-runner-successor";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);
        let runnerB: ClientSocket | null = null;

        try {
            const runnerA = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            });
            await killRunner(runnerA, seeded.sessionId);
            // A's exit report is retained (delayed staging, a slow machine socket) while B takes over.
            runnerB = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-b",
            });
            await beginTurn(seeded.accountId, seeded.sessionId, "turn-runner-b");
            const beforeReport = await readPresence(seeded.sessionId);
            expect(beforeReport).toMatchObject({ active: true, latestTurnId: "turn-runner-b" });
            await connect(daemon);

            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });

            expect(ack).toEqual({ status: "rejected", sessionId: seeded.sessionId, reason: "unmatched" });
            await expect(readPresence(seeded.sessionId)).resolves.toEqual(beforeReport);
        } finally {
            runnerB?.close();
            daemon.close();
            await app.close();
        }
    }, 30_000);

    it("never retires the current publisher for an exit report that does not name the exited runner", async () => {
        const machineId = "m-runner-unnamed";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);
        let runnerB: ClientSocket | null = null;

        try {
            const runnerA = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            });
            await killRunner(runnerA, seeded.sessionId);
            runnerB = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-b",
            });
            await beginTurn(seeded.accountId, seeded.sessionId, "turn-runner-b-unnamed");
            const beforeReport = await readPresence(seeded.sessionId);
            await connect(daemon);

            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
            });

            expect(ack).toEqual({ status: "rejected", reason: "invalid_request" });
            await expect(readPresence(seeded.sessionId)).resolves.toEqual(beforeReport);
        } finally {
            runnerB?.close();
            daemon.close();
            await app.close();
        }
    }, 30_000);

    it("ignores a runner-exit report from a machine that does not host the session", async () => {
        const machineId = "m-runner-host";
        const seeded = await seedMachineSession(machineId);
        const otherMachineId = "m-runner-other";
        await db.machine.create({
            data: {
                id: otherMachineId,
                accountId: seeded.accountId,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });
        const { app, url } = await startServer();
        const otherDaemon = machineSocket(url, seeded.token, otherMachineId);

        try {
            const runnerA = await registerRunner({
                url, token: seeded.token, machineId, sessionId: seeded.sessionId, publisherIncarnationId: "runner-a",
            });
            await killRunner(runnerA, seeded.sessionId);
            await connect(otherDaemon);

            const ack = await otherDaemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
                publisherIncarnationId: "runner-a",
            });

            expect(ack).toEqual({
                status: "rejected",
                sessionId: seeded.sessionId,
                reason: "machine_control_unavailable",
            });
            await expect(readPresence(seeded.sessionId)).resolves.toMatchObject({ active: true });
        } finally {
            otherDaemon.close();
            await app.close();
        }
    }, 30_000);
});
