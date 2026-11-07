// Released runners (0.2.x) emit `message` as soon as a new session socket connects and register as the
// transcript publisher only on their next heartbeat / Runtime Activity snapshot. The `message` fence must give
// that socket a bounded wait for its own canonical registration instead of a permanent `forbidden`.
// Real sessionPublisherPresence + real released `session-alive` adapter + real `message` handler; only the DB
// boundary is faked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

type Row = {
    id: string; accountId: string; archivedAt: Date | null; active: boolean; lastActiveAt: Date;
    publisherGeneration: bigint; publisherGenerationLastActiveAt: Date | null; updatedAt: Date;
    runtimeActivityState: string | null; runtimeActivityActiveCount: number | null;
    runtimeActivityObservedAt: Date | null; runtimeActivityRevision: number | null;
};
const store = vi.hoisted(() => ({ row: null as any }));
const sessionTable = vi.hoisted(() => ({
    findUnique: async ({ where }: any) => (store.row && store.row.id === where.id ? { ...store.row } : null),
    updateMany: async ({ where, data }: any) => {
        const row = store.row;
        if (!row) return { count: 0 };
        for (const [k, v] of Object.entries(where)) {
            if (k === "AND") continue;
            const cur = row[k];
            const ok = (cur instanceof Date && v instanceof Date) ? cur.getTime() === (v as Date).getTime() : cur === v;
            if (!ok) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
    },
}));

const createSessionMessage = vi.fn(async (..._args: unknown[]) => ({ ok: true, didWrite: true, message: { id: "m", seq: 1, localId: null, createdAt: new Date(), updatedAt: new Date(), content: {} } }));
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata: vi.fn(),
    updateSessionAgentState: vi.fn(),
    applySessionTurnMutation: vi.fn(),
    applySessionReadCursorOperation: vi.fn(),
    applyLatestSessionTurnEndInTx: vi.fn(async () => ({ didApply: false })),
    selectSessionActivityBadgeInputs: () => ({}),
}));
vi.mock("@/storage/db", () => ({ db: { session: sessionTable, sessionMessage: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/storage/inTx", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/storage/inTx")>(),
    inTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => await fn({ session: sessionTable })),
}));
vi.mock("@/app/api/socket/sessionRelayAuthCache", () => ({
    authorizeSessionRelayPublish: vi.fn(async () => ["user-1"]),
    authorizeSessionScopedMachineBinding: vi.fn(async () => ["user-1"]),
}));
vi.mock("@/app/api/socket/sessionScopedBinding", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/app/api/socket/sessionScopedBinding")>(),
    hasCurrentSessionScopedMachineAccessInTx: vi.fn(async () => true),
}));
vi.mock("@/app/changes/readAccountChangeCursors", () => ({ readAccountChangeCursors: vi.fn(async () => new Map()) }));
vi.mock("@/app/session/changeTracking/markSessionParticipantsChanged", () => ({ markSessionParticipantsChanged: vi.fn(async () => []) }));
vi.mock("@/app/session/pending/providerDeliveryClaimStaleness", () => ({ reofferInheritedProviderDeliveryClaims: vi.fn(async () => undefined) }));
vi.mock("@/app/session/runtimeActivity/writeProjection", () => ({
    writeSessionRuntimeActivityProjectionInTx: vi.fn(async () => ({ status: "unchanged", projection: { state: "unknown", activeCount: 0, revision: 1, observedAt: 1 } })),
    writeSessionRuntimeActivityObserverLossInTx: vi.fn(async () => ({ status: "unchanged", projection: { state: "unknown", activeCount: 0, revision: 1, observedAt: 1 } })),
}));
vi.mock("@/app/session/runtimeActivity/writeAuthorizedProjection", () => ({ writeAuthorizedSessionRuntimeActivityProjection: vi.fn() }));
vi.mock("@/app/session/runtimeActivity/publishPublisherLifecycleUpdate", () => ({ publishSessionPublisherLifecycleUpdate: vi.fn(async () => undefined) }));
vi.mock("@/app/presence/pendingActivationWake", () => ({ readPendingActivationWakeInTx: vi.fn(async () => undefined), emitPendingActivationWake: vi.fn() }));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({ refreshSessionParticipantBadgePushes: vi.fn(async () => undefined) }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
    buildMessageUpdatedUpdate: vi.fn(() => ({})), buildNewMessageUpdate: vi.fn(() => ({})),
    buildPendingChangedUpdate: vi.fn(() => ({})), buildSessionActivityEphemeral: vi.fn(), buildUpdateSessionUpdate: vi.fn(() => ({})),
}));
vi.mock("@/app/share/sessionParticipants", () => ({ getSessionParticipantUserIds: vi.fn(async () => ["user-1"]) }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const binding = { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" } as const;

async function wire(presence: any, id: string) {
    const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
    const { registerSessionRuntimeActivitySnapshotSocketEvent } = await import("@/app/session/runtimeActivity/socketEvents");
    const socket = createFakeSocket({ id });
    // Same wiring order as socket.ts:430-512 for a machine-bound session socket.
    sessionUpdateHandler("user-1", socket as any,
        { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        { presence, binding });
    registerSessionRuntimeActivitySnapshotSocketEvent({ socket: socket as any, presence, binding, publish: async () => {} });
    const sendMessage = async (text: string) => {
        const ack = vi.fn();
        await getSocketHandler(socket, "message")({ sid: "s-1", localId: `l-${text}`, message: { t: "plain", v: { role: "agent", text } } }, ack);
        return ack.mock.calls[0]?.[0];
    };
    const sendAlive = async () => {
        await getSocketHandler(socket, "session-alive")({ sid: "s-1", time: Date.now(), thinking: true, mode: "remote" });
    };
    return { socket, sendMessage, sendAlive };
}

describe("sessionUpdateHandler message fence: bounded wait for the socket's own canonical registration", () => {
    beforeEach(() => {
        vi.useRealTimers();
        createSessionMessage.mockClear();
        const t = new Date(Date.now() - 5_000);
        store.row = {
            id: "s-1", accountId: "user-1", archivedAt: null, active: true, lastActiveAt: t,
            publisherGeneration: 7n, publisherGenerationLastActiveAt: t, updatedAt: t,
            runtimeActivityState: null, runtimeActivityActiveCount: null, runtimeActivityObservedAt: null, runtimeActivityRevision: null,
        } satisfies Row;
    });
    const fresh = async () => (await import("@/app/presence/sessionPublisherPresence")).createSessionPublisherPresence();

    it("released runner reconnects after relay restart: message sent before its heartbeat is accepted once the heartbeat registers it", async () => {
        const presence = await fresh();
        const runner = await wire(presence, "runner-after-restart");
        const pending = runner.sendMessage("emitted-in-window");
        await new Promise((r) => setTimeout(r, 200));
        expect(createSessionMessage).not.toHaveBeenCalled();
        await runner.sendAlive();
        expect(await pending).toMatchObject({ ok: true });
        expect(createSessionMessage).toHaveBeenCalledTimes(1);
        expect(store.row.publisherGeneration).toBe(8n);
        const call = createSessionMessage.mock.calls[0]![0] as any;
        expect(call.trustedPublisherFence.committedFence.getTime()).toBe(store.row.lastActiveAt.getTime());
    });

    it("queued messages from the window are written in emission order after registration", async () => {
        const presence = await fresh();
        const runner = await wire(presence, "r");
        const a = runner.sendMessage("a");
        const b = runner.sendMessage("b");
        await runner.sendAlive();
        expect(await a).toMatchObject({ ok: true });
        expect(await b).toMatchObject({ ok: true });
        expect(createSessionMessage.mock.calls.map((c: any) => c[0].localId)).toEqual(["l-a", "l-b"]);
    });

    it("superseded socket is still refused forbidden immediately (no grace)", async () => {
        const presence = await fresh();
        const stale = await wire(presence, "stale");
        await stale.sendAlive();
        const successor = await wire(presence, "successor");
        await successor.sendAlive();
        const t0 = Date.now();
        expect(await stale.sendMessage("stale")).toEqual({ ok: false, error: "forbidden" });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(await successor.sendMessage("succ")).toMatchObject({ ok: true });
        expect(createSessionMessage).toHaveBeenCalledTimes(1);
    });

    it("admission order is exactly registration order: a waiting socket is admitted only as the publisher its own later registration made current", async () => {
        const presence = await fresh();
        const stale = await wire(presence, "stale");
        const successor = await wire(presence, "successor");
        const pending = stale.sendMessage("stale-in-window");
        await successor.sendAlive();              // successor becomes current; stale stays unregistered
        await stale.sendAlive();                  // stale registers itself (legacy adapter, pre-existing authority) ...
        expect(await pending).toMatchObject({ ok: true }); // ... so its write is admitted only as the now-current publisher
        expect(await successor.sendMessage("succ")).toEqual({ ok: false, error: "forbidden" });
    });

    it("waiting socket that never registers is not admitted while a successor registers and writes", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const presence = await fresh();
        const stale = await wire(presence, "stale-silent");
        const successor = await wire(presence, "successor");
        const pending = stale.sendMessage("stale");
        await successor.sendAlive();
        expect(await successor.sendMessage("succ")).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(5_100);
        expect(await pending).toEqual({ ok: false, error: "transaction-unavailable" });
        expect(createSessionMessage.mock.calls.map((c: any) => c[0].localId)).toEqual(["l-succ"]);
    });

    it("socket that never registers: transaction-unavailable at the deadline, nothing written", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const presence = await fresh();
        const runner = await wire(presence, "silent");
        const pending = runner.sendMessage("x");
        await vi.advanceTimersByTimeAsync(4_900);
        expect(createSessionMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(await pending).toEqual({ ok: false, error: "transaction-unavailable" });
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("messages queued on one socket share a single registration budget measured from receipt", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const presence = await fresh();
        const runner = await wire(presence, "queued-silent");
        const t0 = Date.now();
        const answeredAt: number[] = [];
        const pending = ["a", "b", "c"].map((text) => runner.sendMessage(text).then((ack) => {
            answeredAt.push(Date.now() - t0);
            return ack;
        }));
        await vi.advanceTimersByTimeAsync(5_100);
        expect(await Promise.all(pending)).toEqual([
            { ok: false, error: "transaction-unavailable" },
            { ok: false, error: "transaction-unavailable" },
            { ok: false, error: "transaction-unavailable" },
        ]);
        // Every answer arrives within the one grace period, far below the released client's 10s ACK timeout.
        expect(Math.max(...answeredAt)).toBeLessThanOrEqual(5_000);
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("a refused queued message is admitted once when its retry arrives and the socket registers", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const presence = await fresh();
        const runner = await wire(presence, "late-heartbeat");
        const bestEffort = runner.sendMessage("best-effort");
        const required = runner.sendMessage("required");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await bestEffort).toEqual({ ok: false, error: "transaction-unavailable" });
        expect(await required).toEqual({ ok: false, error: "transaction-unavailable" });
        await vi.advanceTimersByTimeAsync(1_000);
        const retried = runner.sendMessage("required");
        await vi.advanceTimersByTimeAsync(1_000);
        await runner.sendAlive();
        expect(await retried).toMatchObject({ ok: true });
        expect(createSessionMessage.mock.calls.map((c: any) => c[0].localId)).toEqual(["l-required"]);
    });

    it.each([0, 50])("disconnect while waiting releases the writer without a write (disconnect after %dms)", async (delayMs) => {
        const presence = await fresh();
        const runner = await wire(presence, "gone");
        const pending = runner.sendMessage("x");
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const t0 = Date.now();
        await presence.forgetDisconnectedPublisher({ socket: runner.socket });
        expect(await pending).toEqual({ ok: false, error: "transaction-unavailable" });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("closed publisher (clean close) stays refused forbidden", async () => {
        const presence = await fresh();
        const runner = await wire(presence, "closing");
        await runner.sendAlive();
        const ack = vi.fn();
        await getSocketHandler(runner.socket, "session-runtime-activity-close")({ sessionId: "s-1" }, ack);
        expect(ack.mock.calls[0]![0]).toMatchObject({ status: "closed" });
        expect(await runner.sendMessage("after-close")).toEqual({ ok: false, error: "forbidden" });
    });
});
