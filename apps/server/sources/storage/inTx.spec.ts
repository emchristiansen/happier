import { afterEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock } from "../app/api/testkit/dbMocks";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));
vi.mock("@/utils/logging/log", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/logging/log")>()),
    warn: warnMock,
}));

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        vi.restoreAllMocks();
        transaction.mockClear();
        delayMock.mockClear();
        warnMock.mockReset();
    });

    it("uses serializable transactions by default", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 123);

        expect(result).toBe(123);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(expect.objectContaining({ isolationLevel: "Serializable" }));
    });

    it("passes timeout options without isolationLevel on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: expect.any(Number),
                timeout: expect.any(Number),
            }),
        );
        expect(transaction.mock.calls[0]![1]).not.toEqual(expect.objectContaining({ isolationLevel: expect.anything() }));
    });

    it("uses configured SQLite transaction timeout options", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TIMEOUT_MS: "12000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
        });

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 654);

        expect(result).toBe(654);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: 7000,
                timeout: 12000,
            }),
        );
    });

    it("retries P2034 and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 789);

        expect(result).toBe(789);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each(["postgres", "mysql"])("retries an acquisition-shaped P2028 before the transaction callback starts on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction
            .mockRejectedValueOnce(acquisitionError)
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));
        const transactionBody = vi.fn(async () => 790);

        const { inTx } = await import("./inTx");
        const result = await inTx(transactionBody);

        expect(result).toBe(790);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each(["postgres", "mysql"])("reports acquisition unavailability with the original P2028 after retries are exhausted on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction.mockRejectedValue(acquisitionError);
        const transactionBody = vi.fn(async () => 791);

        const { inTx, TransactionAcquisitionUnavailableError } = await import("./inTx");
        const rejection = await inTx(transactionBody).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transaction).toHaveBeenCalledTimes(4);
        expect(transactionBody).not.toHaveBeenCalled();
        expect(delayMock).toHaveBeenCalledTimes(3);
    });

    it.each(["postgres", "sqlite", "mysql"])("does not retry an acquisition-shaped P2028 after the transaction callback starts on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const operationError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const transactionBody = vi.fn(async () => {
            throw operationError;
        });

        const { inTx } = await import("./inTx");
        await expect(inTx(transactionBody)).rejects.toBe(operationError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it("retries sqlite P1008 socket timeout and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Socket timeout"), { code: "P1008" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 9001);

        expect(result).toBe(9001);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("retries sqlite P2024 transaction pool timeouts and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const { inTx } = await import("./inTx");
        const result = await inTx(async () => 9002);

        expect(result).toBe(9002);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("does not schedule a sqlite retry that would exceed the configured transaction budget", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_MAX_RETRIES: "8",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "15000",
        });
        const timeoutError = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        transaction.mockRejectedValue(timeoutError);
        vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(20_000);

        const { inTx } = await import("./inTx");
        await expect(inTx(async () => 9003)).rejects.toBe(timeoutError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    describe("after-commit callbacks", () => {
        // Node reports an unhandled rejection only after the microtask queue drains, so wait a full macrotask turn.
        const settleUnhandledRejectionDetection = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

        async function captureUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
            const unhandled: unknown[] = [];
            const onUnhandledRejection = (reason: unknown) => {
                unhandled.push(reason);
            };
            process.on("unhandledRejection", onUnhandledRejection);
            try {
                await run();
                await settleUnhandledRejectionDetection();
            } finally {
                process.off("unhandledRejection", onUnhandledRejection);
            }
            return unhandled;
        }

        const failureMessage = "afterTx callback failed after commit; the committed transaction is unaffected";

        function expectedFailureLog(failure: "threw" | "rejected", err: unknown, callbackName?: string) {
            return [
                {
                    module: "storage",
                    event: "after-tx-callback-failed",
                    failure,
                    // The frame that called afterTx: the transaction body in this spec file.
                    callSite: expect.stringMatching(/inTx\.spec\.ts:\d+:\d+/),
                    callbackName,
                    err,
                },
                failureMessage,
            ];
        }

        it("logs a synchronously throwing callback at warn and still runs the later callbacks", async () => {
            const { inTx, afterTx } = await import("./inTx");
            const failure = new Error("sync after-commit failure");
            const later = vi.fn();

            const unhandled = await captureUnhandledRejections(async () => {
                const result = await inTx(async (tx) => {
                    afterTx(tx, () => {
                        throw failure;
                    });
                    afterTx(tx, later);
                    return 321;
                });
                expect(result).toBe(321);
            });

            expect(later).toHaveBeenCalledTimes(1);
            expect(warnMock).toHaveBeenCalledTimes(1);
            expect(warnMock.mock.calls[0]).toEqual(expectedFailureLog("threw", failure));
            expect(unhandled).toEqual([]);
        });

        it("logs a rejected async callback with the same log line as a synchronous throw, without an unhandled rejection", async () => {
            const { inTx, afterTx } = await import("./inTx");
            const failure = new Error("async after-commit failure");
            const later = vi.fn();
            const emitAfterCommit = async () => {
                throw failure;
            };

            const unhandled = await captureUnhandledRejections(async () => {
                const result = await inTx(async (tx) => {
                    afterTx(tx, emitAfterCommit);
                    afterTx(tx, later);
                    return 654;
                });
                expect(result).toBe(654);
            });

            expect(later).toHaveBeenCalledTimes(1);
            expect(warnMock).toHaveBeenCalledTimes(1);
            expect(warnMock.mock.calls[0]).toEqual(expectedFailureLog("rejected", failure, "emitAfterCommit"));
            expect(unhandled).toEqual([]);
        });

        it("returns the transaction result without waiting for an async callback to settle", async () => {
            const { inTx, afterTx } = await import("./inTx");
            let rejectCallback!: (error: unknown) => void;
            const pending = new Promise<void>((_resolve, reject) => {
                rejectCallback = reject;
            });
            const lateFailure = new Error("late async after-commit failure");
            const order: string[] = [];

            const unhandled = await captureUnhandledRejections(async () => {
                const result = await inTx(async (tx) => {
                    afterTx(tx, () => {
                        order.push("async callback started");
                        return pending;
                    });
                    afterTx(tx, () => {
                        order.push("next callback ran");
                    });
                    return 987;
                });
                order.push("inTx returned");
                expect(result).toBe(987);
                expect(warnMock).not.toHaveBeenCalled();
                rejectCallback(lateFailure);
            });

            expect(order).toEqual(["async callback started", "next callback ran", "inTx returned"]);
            expect(warnMock).toHaveBeenCalledTimes(1);
            expect(warnMock.mock.calls[0]).toEqual(expectedFailureLog("rejected", lateFailure));
            expect(unhandled).toEqual([]);
        });

        it("keeps the committed result, without a retry or an unhandled rejection, when the failure log itself throws", async () => {
            const { inTx, afterTx } = await import("./inTx");
            warnMock.mockImplementation(() => {
                throw new Error("logger failure");
            });

            const unhandled = await captureUnhandledRejections(async () => {
                const result = await inTx(async (tx) => {
                    afterTx(tx, () => {
                        throw new Error("sync after-commit failure");
                    });
                    afterTx(tx, async () => {
                        throw new Error("async after-commit failure");
                    });
                    return 135;
                });
                expect(result).toBe(135);
            });

            // pino serializes the log object inside the `warn` call, so a serializer failure surfaces here too.
            expect(warnMock).toHaveBeenCalledTimes(2);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(unhandled).toEqual([]);
        });
    });
});
