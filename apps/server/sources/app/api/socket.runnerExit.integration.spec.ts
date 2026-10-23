import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { auth } from "@/app/auth/auth";
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

    /** Registers a runner as the session's publisher, then kills its connection the way a dead process does. */
    async function registerRunnerThenDie(params: Readonly<{
        url: string;
        token: string;
        machineId: string;
        sessionId: string;
    }>): Promise<void> {
        const runner = ioClient(params.url, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token: params.token,
                clientType: "session-scoped",
                sessionId: params.sessionId,
                machineId: params.machineId,
            },
        });
        try {
            await connect(runner);
            const ack = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, {
                sessionId: params.sessionId,
                mutationId: "runner-registration",
                snapshot: { state: "active", activeCount: 1 },
            });
            expect(ack).toMatchObject({ status: "applied", sessionId: params.sessionId });
        } finally {
            runner.close();
        }
        // The server forgets the dead publisher on disconnect, but `active` stays true.
        await waitFor(async () => {
            const session = await db.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { runtimeActivityState: true },
            });
            return session.runtimeActivityState === "unknown";
        }, "Expected the server to process the runner disconnect");
        await expect(db.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    }

    it("stops reading active once the session's machine reports that its runner exited", async () => {
        const machineId = "m-runner-exit";
        const seeded = await seedMachineSession(machineId);
        const { app, url } = await startServer();
        const daemon = machineSocket(url, seeded.token, machineId);

        try {
            await registerRunnerThenDie({ url, token: seeded.token, machineId, sessionId: seeded.sessionId });
            await connect(daemon);

            const ack = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
            });

            expect(ack).toEqual({ status: "closed", sessionId: seeded.sessionId });
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true, publisherGenerationLastActiveAt: true },
            })).resolves.toEqual({ active: false, publisherGenerationLastActiveAt: null });

            const repeated = await daemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
            });
            expect(repeated).toEqual({ status: "already_inactive", sessionId: seeded.sessionId });
        } finally {
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
            await registerRunnerThenDie({ url, token: seeded.token, machineId, sessionId: seeded.sessionId });
            await connect(otherDaemon);

            const ack = await otherDaemon.timeout(5_000).emitWithAck(MACHINE_SESSION_RUNNER_EXITED_EVENT, {
                sessionId: seeded.sessionId,
            });

            expect(ack).toEqual({
                status: "rejected",
                sessionId: seeded.sessionId,
                reason: "machine_control_unavailable",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true },
            })).resolves.toEqual({ active: true });
        } finally {
            otherDaemon.close();
            await app.close();
        }
    }, 30_000);
});
