import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    authorizeSessionScopedMachineBinding,
    clearSessionRelayAuthorizationCache,
    invalidateSessionRelayAuthorizationForMachine,
} from "./sessionRelayAuthCache";

// Wraps the real participant lookup so a test can hold one resolution between its access reads and
// its participant read, the window in which a revocation can commit.
const participantLookup = vi.hoisted(() => ({
    calls: 0,
    holdNext: null as null | { reached: () => void; release: Promise<void> },
}));
vi.mock("@/app/share/sessionParticipants", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/share/sessionParticipants")>();
    return {
        ...actual,
        getSessionParticipantUserIds: async (...args: Parameters<typeof actual.getSessionParticipantUserIds>) => {
            participantLookup.calls += 1;
            const hold = participantLookup.holdNext;
            participantLookup.holdNext = null;
            if (hold) {
                hold.reached();
                await hold.release;
            }
            return await actual.getSessionParticipantUserIds(...args);
        },
    };
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

describe("session relay auth cache on SQLite without a read pool", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        delete process.env.HAPPIER_SQLITE_READ_POOL_SIZE;
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-relay-auth-cache-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => {
        harness.resetEnv();
        clearSessionRelayAuthorizationCache();
        participantLookup.calls = 0;
        participantLookup.holdNext = null;
    });
    afterAll(async () => await harness.close());

    it("runs on the default single write connection with no read pool", () => {
        expect(process.env.HAPPIER_SQLITE_READ_POOL_SIZE).toBeUndefined();
        const url = new URL(String(process.env.DATABASE_URL));
        expect(url.searchParams.getAll("connection_limit")).toEqual(["1"]);
    });

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `session-${randomUUID()}`, metadata: "{}" },
            select: { id: true },
        });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
        await db.sessionShare.create({
            data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: participant.id, accessLevel: "view" },
        });
        return {
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            participantIds: [owner.id, participant.id].sort(),
        };
    }

    // The access-key half of a machine revoke as machinesRoutes.ts performs it: the write commits in
    // a transaction and the relay-auth invalidation runs in afterTx, after the commit.
    async function revokeMachineAccessKeys(binding: { accountId: string; machineId: string }) {
        await inTx(async (tx) => {
            await tx.accessKey.deleteMany({ where: { accountId: binding.accountId, machineId: binding.machineId } });
            afterTx(tx, () => invalidateSessionRelayAuthorizationForMachine(binding.machineId));
        });
    }

    it("caches an uncrossed grant", async () => {
        const seeded = await seed();
        const first = await authorizeSessionScopedMachineBinding(seeded.binding);
        const second = await authorizeSessionScopedMachineBinding(seeded.binding);
        expect([...(first ?? [])].sort()).toEqual(seeded.participantIds);
        expect(second).toEqual(first);
        expect(participantLookup.calls).toBe(1);
    });

    it("does not answer or cache a grant whose resolution a committed revocation crossed", async () => {
        const seeded = await seed();
        const reached = deferred();
        const release = deferred();
        participantLookup.holdNext = { reached: reached.resolve, release: release.promise };

        const crossed = authorizeSessionScopedMachineBinding(seeded.binding);
        // The access-key and owner reads have answered "authorized"; the participant read is held.
        await reached.promise;
        await revokeMachineAccessKeys(seeded.binding);
        expect(await db.accessKey.count({ where: { machineId: seeded.binding.machineId } })).toBe(0);
        release.resolve();

        // Both the straddling call and the next call (which a cached grant would answer) are refused.
        const crossedAnswer = await crossed;
        const nextAnswer = await authorizeSessionScopedMachineBinding(seeded.binding);
        expect({ crossedAnswer, nextAnswer }).toEqual({ crossedAnswer: null, nextAnswer: null });
    });
});
