import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CheckSessionAccessFn = typeof import("@/app/share/accessControl").checkSessionAccess;
type RequireAccessLevelFn = typeof import("@/app/share/accessControl").requireAccessLevel;
type GetSessionParticipantUserIdsFn = typeof import("@/app/share/sessionParticipants").getSessionParticipantUserIds;

const checkSessionAccess = vi.fn<CheckSessionAccessFn>();
const requireAccessLevel = vi.fn<RequireAccessLevelFn>();
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

const getSessionParticipantUserIds = vi.fn<GetSessionParticipantUserIdsFn>();
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));

type AccessKeyAccessProof = Readonly<{
    machine: Readonly<{ revokedAt: Date | null; replacedByMachineId: string | null }>;
    session: Readonly<{ accountId: string }>;
}>;

const currentAccessProof: AccessKeyAccessProof = {
    machine: { revokedAt: null, replacedByMachineId: null },
    session: { accountId: "u1" },
};
const accessKeyFindUnique = vi.hoisted(() => vi.fn(async (): Promise<AccessKeyAccessProof | null> => currentAccessProof));
vi.mock("@/storage/db", () => ({
    db: {
        accessKey: {
            findUnique: accessKeyFindUnique,
        },
    },
}));

// The write connection: inTx hands its callback a transaction client with its own accessKey reads.
const writeAccessKeyFindUnique = vi.hoisted(() => vi.fn(async (): Promise<AccessKeyAccessProof | null> => null));
const writeTx = vi.hoisted(() => ({ accessKey: { findUnique: writeAccessKeyFindUnique } }));
const inTx = vi.hoisted(() => vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => await fn(writeTx)));
vi.mock("@/storage/inTx", () => ({ inTx }));

function createBoundSocket(overrides: Partial<{ sessionId: string; machineId: string | null; proof: string }> = {}) {
    return {
        data: {
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
                ...overrides,
            },
        },
    };
}

function createConnection(socket: unknown, overrides: Partial<{ connectionType: string; sessionId: string }> = {}) {
    return {
        connectionType: "session-scoped",
        socket,
        userId: "u1",
        sessionId: "s1",
        ...overrides,
    };
}

async function loadModule() {
    return await import("./sessionRelayAuthCache");
}

describe("sessionRelayAuthCache", () => {
    beforeEach(async () => {
        checkSessionAccess.mockReset();
        requireAccessLevel.mockReset();
        getSessionParticipantUserIds.mockReset();
        accessKeyFindUnique.mockReset();
        accessKeyFindUnique.mockResolvedValue(currentAccessProof);
        writeAccessKeyFindUnique.mockReset();
        writeAccessKeyFindUnique.mockResolvedValue(currentAccessProof);
        inTx.mockClear();
        checkSessionAccess.mockImplementation(async (userId, sessionId) => ({
            userId,
            sessionId,
            level: "owner",
            isOwner: true,
        } as any));
        requireAccessLevel.mockReturnValue(true);
        getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
        const { clearSessionRelayAuthorizationCache } = await loadModule();
        clearSessionRelayAuthorizationCache();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns null without touching the database when the socket has no machine-bound session proof", async () => {
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket({ machineId: null, proof: "owner-session" });

        const result = await authorizeSessionRelayPublish({
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        });

        expect(result).toBeNull();
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
        expect(checkSessionAccess).not.toHaveBeenCalled();
    });

    it("returns null without touching the database when the event targets a different session than the binding", async () => {
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();

        const result = await authorizeSessionRelayPublish({
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s2",
        });

        expect(result).toBeNull();
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });

    it("returns null for non-session-scoped connections", async () => {
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();

        const result = await authorizeSessionRelayPublish({
            socket: socket as any,
            connection: createConnection(socket, { connectionType: "user-scoped" }) as any,
            userId: "u1",
            sessionId: "s1",
        });

        expect(result).toBeNull();
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });

    it("verifies access key, owner access, and participants once, then serves subsequent calls from cache", async () => {
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        const first = await authorizeSessionRelayPublish(params);
        const second = await authorizeSessionRelayPublish(params);

        expect(first).toEqual(["u1", "u2"]);
        expect(second).toEqual(["u1", "u2"]);
        expect(accessKeyFindUnique).toHaveBeenCalledTimes(1);
        expect(accessKeyFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_machineId_sessionId: {
                    accountId: "u1",
                    machineId: "m1",
                    sessionId: "s1",
                },
            },
            select: {
                machine: {
                    select: { revokedAt: true, replacedByMachineId: true },
                },
                session: {
                    select: { accountId: true },
                },
            },
        });
        expect(checkSessionAccess).toHaveBeenCalledTimes(1);
        expect(checkSessionAccess).toHaveBeenCalledWith("u1", "s1", expect.anything()); // third argument: the pool reader (global db)
        expect(getSessionParticipantUserIds).toHaveBeenCalledTimes(1);
    });

    it("re-verifies after the cache TTL elapses", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const { authorizeSessionRelayPublish, SESSION_RELAY_AUTH_CACHE_TTL_MS } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        await authorizeSessionRelayPublish(params);
        vi.setSystemTime(1_000_000 + SESSION_RELAY_AUTH_CACHE_TTL_MS + 1);
        await authorizeSessionRelayPublish(params);

        expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
        expect(checkSessionAccess).toHaveBeenCalledTimes(2);
    });

    it("does not cache negative results", async () => {
        accessKeyFindUnique.mockResolvedValueOnce(null);
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        const first = await authorizeSessionRelayPublish(params);
        const second = await authorizeSessionRelayPublish(params);

        expect(first).toBeNull();
        expect(second).toEqual(["u1", "u2"]);
        expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["a revoked machine", { ...currentAccessProof, machine: { ...currentAccessProof.machine, revokedAt: new Date(0) } }],
        ["a replaced machine", { ...currentAccessProof, machine: { ...currentAccessProof.machine, replacedByMachineId: "m2" } }],
        ["a session owned by another account", { ...currentAccessProof, session: { accountId: "u2" } }],
    ] as const)("fails closed for %s even when an access-key row remains", async (_description, accessProof) => {
        accessKeyFindUnique.mockResolvedValue(accessProof);
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();

        await expect(authorizeSessionRelayPublish({
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        })).resolves.toBeNull();
        expect(checkSessionAccess).not.toHaveBeenCalled();
    });

    it("returns null and does not cache when the sender is not the session owner", async () => {
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: false,
        } as any);
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        expect(await authorizeSessionRelayPublish(params)).toBeNull();
        expect(await authorizeSessionRelayPublish(params)).toBeNull();
        expect(checkSessionAccess).toHaveBeenCalledTimes(2);
    });

    it("returns null when edit access is missing", async () => {
        requireAccessLevel.mockReturnValue(false);
        const { authorizeSessionRelayPublish } = await loadModule();
        const socket = createBoundSocket();

        const result = await authorizeSessionRelayPublish({
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        });

        expect(result).toBeNull();
        expect(requireAccessLevel).toHaveBeenCalledWith(expect.objectContaining({ level: "owner" }), "edit");
    });

    it("re-verifies after session-scoped invalidation", async () => {
        const { authorizeSessionRelayPublish, invalidateSessionRelayAuthorizationForSession } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        await authorizeSessionRelayPublish(params);
        invalidateSessionRelayAuthorizationForSession("s1");
        await authorizeSessionRelayPublish(params);

        expect(checkSessionAccess).toHaveBeenCalledTimes(2);
    });

    it("re-verifies after machine-scoped invalidation", async () => {
        const { authorizeSessionRelayPublish, invalidateSessionRelayAuthorizationForMachine } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        await authorizeSessionRelayPublish(params);
        invalidateSessionRelayAuthorizationForMachine("m1");
        await authorizeSessionRelayPublish(params);

        expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
    });

    it("keeps unrelated cache entries when invalidating another session", async () => {
        const { authorizeSessionRelayPublish, invalidateSessionRelayAuthorizationForSession } = await loadModule();
        const socket = createBoundSocket();
        const params = {
            socket: socket as any,
            connection: createConnection(socket) as any,
            userId: "u1",
            sessionId: "s1",
        };

        await authorizeSessionRelayPublish(params);
        invalidateSessionRelayAuthorizationForSession("s-other");
        await authorizeSessionRelayPublish(params);

        expect(checkSessionAccess).toHaveBeenCalledTimes(1);
    });

    describe("a fill that was reading when an invalidation ran", () => {
        function deferred<T>() {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((r) => {
                resolve = r;
            });
            return { promise, resolve };
        }

        async function startFillHeldAtParticipantLookup() {
            const { authorizeSessionRelayPublish } = await loadModule();
            const socket = createBoundSocket();
            const params = {
                socket: socket as any,
                connection: createConnection(socket) as any,
                userId: "u1",
                sessionId: "s1",
            };
            const participants = deferred<string[]>();
            const participantLookupStarted = deferred<void>();
            getSessionParticipantUserIds.mockImplementationOnce(async () => {
                participantLookupStarted.resolve();
                return await participants.promise;
            });
            const inFlight = authorizeSessionRelayPublish(params);
            // The fill has read the access key and owner access (pre-revocation state) and is waiting
            // on its last read when the revoking write commits and its afterTx invalidation runs.
            await participantLookupStarted.promise;
            return { authorizeSessionRelayPublish, params, participants, inFlight };
        }

        it("re-resolves a grant that a machine revocation invalidated while it was reading, and neither returns nor stores it", async () => {
            const { invalidateSessionRelayAuthorizationForMachine } = await loadModule();
            const fill = await startFillHeldAtParticipantLookup();
            accessKeyFindUnique.mockResolvedValue(null); // the revocation deleted the access key
            invalidateSessionRelayAuthorizationForMachine("m1");
            fill.participants.resolve(["u1", "u2"]);

            await expect(fill.inFlight).resolves.toBeNull();
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toBeNull();
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(3);
        });

        it("re-resolves a grant that a session invalidation (share revoke, delete) invalidated while it was reading", async () => {
            const { invalidateSessionRelayAuthorizationForSession } = await loadModule();
            const fill = await startFillHeldAtParticipantLookup();
            checkSessionAccess.mockResolvedValue(null); // e.g. the session was deleted
            invalidateSessionRelayAuthorizationForSession("s1");
            fill.participants.resolve(["u1", "u2"]);

            await expect(fill.inFlight).resolves.toBeNull();
            expect(checkSessionAccess).toHaveBeenCalledTimes(2);
            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toBeNull();
        });

        it("re-resolves after an invalidation that named another session, then caches the fresh grant", async () => {
            const { invalidateSessionRelayAuthorizationForSession } = await loadModule();
            const fill = await startFillHeldAtParticipantLookup();
            invalidateSessionRelayAuthorizationForSession("s-other");
            fill.participants.resolve(["u1", "u2"]);

            await expect(fill.inFlight).resolves.toEqual(["u1", "u2"]);
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toEqual(["u1", "u2"]);
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
        });

        async function crossBothPoolResolutions() {
            const { invalidateSessionRelayAuthorizationForMachine } = await loadModule();
            const fill = await startFillHeldAtParticipantLookup();
            invalidateSessionRelayAuthorizationForMachine("m-other");
            getSessionParticipantUserIds.mockImplementationOnce(async () => {
                invalidateSessionRelayAuthorizationForMachine("m-other-2");
                return ["u1", "u2"];
            });
            fill.participants.resolve(["u1", "u2"]);
            return fill;
        }

        function expectThirdResolutionOnWriteConnection() {
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(2); // the two pool attempts only
            expect(inTx).toHaveBeenCalledTimes(1);
            expect(writeAccessKeyFindUnique).toHaveBeenCalledTimes(1);
        }

        it("answers from the write connection when invalidations cross both pool resolutions, and admits a still-authorized binding without caching it", async () => {
            const fill = await crossBothPoolResolutions();
            getSessionParticipantUserIds.mockImplementationOnce(async () => ["u1", "u3"]);

            await expect(fill.inFlight).resolves.toEqual(["u1", "u3"]);
            expectThirdResolutionOnWriteConnection();
            expect(checkSessionAccess).toHaveBeenLastCalledWith("u1", "s1", writeTx);
            expect(getSessionParticipantUserIds).toHaveBeenLastCalledWith({ sessionId: "s1", tx: writeTx });

            // Not cached: the next call resolves again on the pool.
            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toEqual(["u1", "u2"]);
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(3);
            expect(inTx).toHaveBeenCalledTimes(1);
        });

        it("answers from the write connection when invalidations cross both pool resolutions, and refuses a revoked binding because the current state says so", async () => {
            const fill = await crossBothPoolResolutions();
            writeAccessKeyFindUnique.mockResolvedValue(null); // the access key is gone on the write connection

            await expect(fill.inFlight).resolves.toBeNull();
            expectThirdResolutionOnWriteConnection();

            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toEqual(["u1", "u2"]);
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(3);
        });

        it("never installs a grant once an invalidation has run, wherever it lands after the last pool read settles", async () => {
            // Sweep the invalidation across the microtask turns between the fill's last read settling
            // and the call returning, including the gap between the crossing check and the install.
            const { authorizeSessionRelayPublish, clearSessionRelayAuthorizationCache, invalidateSessionRelayAuthorizationForMachine } = await loadModule();
            const socket = createBoundSocket();
            const params = { socket: socket as any, connection: createConnection(socket) as any, userId: "u1", sessionId: "s1" };
            const installedAfterInvalidation: number[] = [];
            for (let turns = 0; turns <= 40; turns += 1) {
                clearSessionRelayAuthorizationCache();
                accessKeyFindUnique.mockReset();
                accessKeyFindUnique.mockResolvedValue(currentAccessProof);
                writeAccessKeyFindUnique.mockReset();
                writeAccessKeyFindUnique.mockResolvedValue(null);
                getSessionParticipantUserIds.mockReset();
                getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);

                const participants = deferred<string[]>();
                getSessionParticipantUserIds.mockImplementationOnce(async () => await participants.promise);
                const inFlight = authorizeSessionRelayPublish(params);
                while (getSessionParticipantUserIds.mock.calls.length === 0) await Promise.resolve();

                participants.resolve(["u1", "u2"]);
                for (let i = 0; i < turns; i += 1) await Promise.resolve();
                // The revocation commits and its afterTx invalidation runs now.
                accessKeyFindUnique.mockResolvedValue(null);
                invalidateSessionRelayAuthorizationForMachine("m1");
                await inFlight;

                const callsBefore = accessKeyFindUnique.mock.calls.length;
                const next = await authorizeSessionRelayPublish(params);
                if (next !== null || accessKeyFindUnique.mock.calls.length === callsBefore) {
                    installedAfterInvalidation.push(turns);
                }
            }
            expect(installedAfterInvalidation).toEqual([]);
        });

        it("still caches a fill that no invalidation overlapped", async () => {
            const fill = await startFillHeldAtParticipantLookup();
            fill.participants.resolve(["u1", "u2"]);
            await fill.inFlight;

            await expect(fill.authorizeSessionRelayPublish(fill.params)).resolves.toEqual(["u1", "u2"]);
            expect(accessKeyFindUnique).toHaveBeenCalledTimes(1);
        });
    });
});
