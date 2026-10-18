import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAckResponseSchema } from "@happier-dev/protocol";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../testkit/dbMocks";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

// Only the database and socket transport are doubled: admission classification,
// local-ID reconciliation, the write service and the ACK handler remain real.
const tx = createDbMocks({
    session: ["findUnique"],
    sessionMessage: ["findUnique", "create", "update"],
});
const { transaction, wrapDb } = createDbTransactionMock(() => tx.db);
installDbModuleMock({ db: wrapDb(tx.db) });

const acquisitionError = () => Object.assign(
    new Error("Unable to start a transaction in the given time."),
    { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
);

describe("transcript transaction admission through the socket ACK", () => {
    beforeEach(() => {
        vi.stubEnv("HAPPIER_DB_PROVIDER", "sqlite");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        tx.reset();
        transaction.mockClear();
        tx.db.session.findUnique.mockResolvedValue({ accountId: "owner", encryptionMode: "e2ee" });
        tx.db.sessionMessage.findUnique.mockResolvedValue({
            id: "already-committed", seq: 7, localId: "original-id", sidechainId: null,
            messageRole: "assistant", content: { t: "encrypted", c: "original-body" },
            createdAt: new Date(1), updatedAt: new Date(1),
        });
    });

    afterEach(() => vi.unstubAllEnvs());

    async function send() {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const socket = createFakeSocket();
        const transportSocket = socket as unknown as Parameters<typeof sessionUpdateHandler>[1];
        sessionUpdateHandler("owner", transportSocket, {
            connectionType: "session-scoped", socket: transportSocket, userId: "owner", sessionId: "s1",
        });
        const callback = vi.fn();
        await getSocketHandler(socket, "message")({
            sid: "s1", localId: "original-id", message: "original-body", messageRole: "assistant",
        }, callback);
        expect(callback).toHaveBeenCalledTimes(1);
        return MessageAckResponseSchema.parse(callback.mock.calls[0]![0]);
    }

    it("preserves a proven before-callback failure and reconciles the same ID on replay", async () => {
        transaction.mockRejectedValueOnce(acquisitionError());
        expect(await send()).toEqual({ ok: false, error: "transaction-unavailable" });
        expect(tx.db.session.findUnique).not.toHaveBeenCalled();

        expect(await send()).toEqual({
            ok: true, id: "already-committed", seq: 7, localId: "original-id", didWrite: false,
        });
        expect(tx.db.sessionMessage.create).not.toHaveBeenCalled();
        expect(tx.db.sessionMessage.update).not.toHaveBeenCalled();
    });

    it("does not classify acquisition-shaped P2028 after callback entry as no-effect", async () => {
        tx.db.session.findUnique.mockRejectedValueOnce(acquisitionError());
        expect(await send()).toEqual({ ok: false, error: "internal" });
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("keeps an execution/commit-uncertain failure distinct from admission", async () => {
        transaction.mockImplementationOnce(async (fn) => {
            if (typeof fn !== "function") throw new Error("Expected interactive transaction");
            await fn(tx.db);
            throw Object.assign(new Error("Transaction already closed"), { code: "P2028" });
        });
        expect(await send()).toEqual({ ok: false, error: "internal" });
    });
});
