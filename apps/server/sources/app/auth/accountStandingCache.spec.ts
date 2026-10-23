import { describe, expect, it } from "vitest";

import type { AccountStanding } from "@/app/auth/accountStanding";
import { createAccountStandingCache } from "@/app/auth/accountStandingCache";

const TTL_MS = 10_000;

type Deferred = {
    readonly promise: Promise<AccountStanding>;
    resolve: (standing: AccountStanding) => void;
    reject: (error: unknown) => void;
};

function deferred(): Deferred {
    let resolve!: (standing: AccountStanding) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<AccountStanding>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function flushMacrotask(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: { maxEntries?: number } = {}) {
    let nowMs = 0;
    const reads: string[] = [];
    let nextResult: () => Promise<AccountStanding> = async () => ({ kind: "active" });
    const cache = createAccountStandingCache({
        ttlMs: TTL_MS,
        maxEntries: options.maxEntries ?? 16,
        now: () => nowMs,
    });
    return {
        cache,
        reads,
        setNow: (ms: number) => {
            nowMs = ms;
        },
        setNextResult: (fn: () => Promise<AccountStanding>) => {
            nextResult = fn;
        },
        resolve: (accountId: string) =>
            cache.resolve(accountId, (id) => {
                reads.push(id);
                return nextResult();
            }),
    };
}

describe("createAccountStandingCache", () => {
    it.each([
        { ttlMs: 0, maxEntries: 1 },
        { ttlMs: -1, maxEntries: 1 },
        { ttlMs: 1.5, maxEntries: 1 },
        { ttlMs: Number.POSITIVE_INFINITY, maxEntries: 1 },
        { ttlMs: 1, maxEntries: 0 },
        { ttlMs: 1, maxEntries: 2.5 },
    ])("rejects invalid options %o", (options) => {
        expect(() => createAccountStandingCache({ ...options, now: () => 0 })).toThrow(/positive integer/);
    });

    it("does not repeat the read for an active account within the bound", async () => {
        const h = harness();
        await expect(h.resolve("a")).resolves.toEqual({ kind: "active" });
        h.setNow(TTL_MS - 1);
        await expect(h.resolve("a")).resolves.toEqual({ kind: "active" });
        expect(h.reads).toEqual(["a"]);
    });

    it("reads again once the bound has passed, measured from when the read started", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const first = h.resolve("a");
        h.setNow(4_000);
        slow.resolve({ kind: "active" });
        await expect(first).resolves.toEqual({ kind: "active" });

        h.setNextResult(async () => ({ kind: "active" }));
        h.setNow(TTL_MS - 1);
        await h.resolve("a");
        expect(h.reads).toEqual(["a"]);

        h.setNow(TTL_MS);
        await h.resolve("a");
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("does not store a result whose read took longer than the bound", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const first = h.resolve("a");
        h.setNow(TTL_MS + 1);
        slow.resolve({ kind: "active" });
        await first;

        h.setNextResult(async () => ({ kind: "active" }));
        await h.resolve("a");
        expect(h.reads).toEqual(["a", "a"]);
    });

    it.each<AccountStanding>([{ kind: "not-found" }, { kind: "disabled" }, { kind: "unavailable" }])(
        "never caches a $kind result",
        async (standing) => {
            const h = harness();
            h.setNextResult(async () => standing);
            await expect(h.resolve("a")).resolves.toEqual(standing);
            h.setNextResult(async () => ({ kind: "active" }));
            await expect(h.resolve("a")).resolves.toEqual({ kind: "active" });
            expect(h.reads).toEqual(["a", "a"]);
        },
    );

    it("never caches a rejected read and passes the rejection to the caller", async () => {
        const h = harness();
        h.setNextResult(async () => {
            throw new Error("boom");
        });
        await expect(h.resolve("a")).rejects.toThrow("boom");
        h.setNextResult(async () => ({ kind: "active" }));
        await expect(h.resolve("a")).resolves.toEqual({ kind: "active" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("lets concurrent callers share one read", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const first = h.resolve("a");
        h.setNow(1_000);
        const second = h.resolve("a");
        slow.resolve({ kind: "disabled" });
        await expect(first).resolves.toEqual({ kind: "disabled" });
        await expect(second).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a"]);
    });

    it("does not let a caller join a read that started a full bound earlier", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const first = h.resolve("a");
        h.setNow(TTL_MS);
        h.setNextResult(async () => ({ kind: "disabled" }));
        await expect(h.resolve("a")).resolves.toEqual({ kind: "disabled" });
        slow.resolve({ kind: "active" });
        await first;
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("forgets an active account when it is invalidated", async () => {
        const h = harness();
        await h.resolve("a");
        h.cache.invalidate("a");
        h.setNextResult(async () => ({ kind: "disabled" }));
        await expect(h.resolve("a")).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("does not store, or let new callers join, a read that was in flight when the account was invalidated", async () => {
        const h = harness();
        const beforeWrite = deferred();
        h.setNextResult(() => beforeWrite.promise);
        // The caller that started the read keeps its own result, exactly as an uncached read racing the write would.
        const starter = h.resolve("a");

        h.cache.invalidate("a");
        const afterWrite = deferred();
        h.setNextResult(() => afterWrite.promise);
        const fresh = h.resolve("a");
        expect(h.reads).toEqual(["a", "a"]);

        beforeWrite.resolve({ kind: "active" });
        await expect(starter).resolves.toEqual({ kind: "active" });
        afterWrite.resolve({ kind: "disabled" });
        await expect(fresh).resolves.toEqual({ kind: "disabled" });

        h.setNextResult(async () => ({ kind: "disabled" }));
        await expect(h.resolve("a")).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a", "a"]);
    });

    it("makes a caller that joined a read before invalidation read again instead of taking the old result", async () => {
        const h = harness();
        const beforeWrite = deferred();
        h.setNextResult(() => beforeWrite.promise);
        const starter = h.resolve("a");
        h.setNow(1_000);
        const joiner = h.resolve("a");

        h.cache.invalidate("a");
        h.setNextResult(async () => ({ kind: "disabled" }));
        beforeWrite.resolve({ kind: "active" });

        await expect(starter).resolves.toEqual({ kind: "active" });
        await expect(joiner).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("makes a caller that joined a read read again when the read settles at or after the bound", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const starter = h.resolve("a");
        h.setNow(TTL_MS - 1_000);
        const joiner = h.resolve("a");

        h.setNow(TTL_MS);
        h.setNextResult(async () => ({ kind: "disabled" }));
        slow.resolve({ kind: "active" });

        await expect(starter).resolves.toEqual({ kind: "active" });
        await expect(joiner).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("lets a joined caller take a result that settles just inside the bound", async () => {
        const h = harness();
        const slow = deferred();
        h.setNextResult(() => slow.promise);
        const starter = h.resolve("a");
        h.setNow(TTL_MS - 1_000);
        const joiner = h.resolve("a");

        h.setNow(TTL_MS - 1);
        slow.resolve({ kind: "disabled" });

        await expect(starter).resolves.toEqual({ kind: "disabled" });
        await expect(joiner).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a"]);
    });

    it("passes a current shared rejection to joined callers, but rereads for them after invalidation", async () => {
        const current = harness();
        const failing = deferred();
        current.setNextResult(() => failing.promise);
        const starter = current.resolve("a");
        const joiner = current.resolve("a");
        failing.reject(new Error("boom"));
        await expect(starter).rejects.toThrow("boom");
        await expect(joiner).rejects.toThrow("boom");
        expect(current.reads).toEqual(["a"]);

        const detached = harness();
        const failingBeforeWrite = deferred();
        detached.setNextResult(() => failingBeforeWrite.promise);
        const detachedStarter = detached.resolve("a");
        const detachedJoiner = detached.resolve("a");
        detached.cache.invalidate("a");
        detached.setNextResult(async () => ({ kind: "active" }));
        failingBeforeWrite.reject(new Error("boom"));
        await expect(detachedStarter).rejects.toThrow("boom");
        await expect(detachedJoiner).resolves.toEqual({ kind: "active" });
        expect(detached.reads).toEqual(["a", "a"]);
    });

    it("makes a caller that joined a younger read that was later displaced read again after an invalidation", async () => {
        const h = harness();
        const r0 = deferred();
        const r1 = deferred();
        const r2 = deferred();

        h.setNextResult(() => r0.promise);
        const a = h.resolve("a");
        h.setNow(9_000);
        const j0 = h.resolve("a");

        h.setNow(TTL_MS);
        h.setNextResult(() => r1.promise);
        const b = h.resolve("a");
        h.setNow(TTL_MS + 10);
        const j1 = h.resolve("a");

        // R0 settles too late for J0, which starts R2; R2 takes the in-flight slot from R1.
        h.setNow(TTL_MS + 20);
        h.setNextResult(() => r2.promise);
        r0.resolve({ kind: "active" });
        await expect(a).resolves.toEqual({ kind: "active" });
        await flushMacrotask();
        expect(h.reads).toEqual(["a", "a", "a"]);

        // A disable commits while R1 (displaced, young) is still pending.
        h.setNow(TTL_MS + 30);
        h.cache.invalidate("a");

        h.setNow(TTL_MS + 40);
        h.setNextResult(async () => ({ kind: "disabled" }));
        r1.resolve({ kind: "active" });
        await expect(b).resolves.toEqual({ kind: "active" });
        await expect(j1).resolves.toEqual({ kind: "disabled" });

        r2.resolve({ kind: "disabled" });
        await expect(j0).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a", "a", "a"]);
    });

    it("makes a joined caller read again when an invalidation lands after the read's cleanup but before the joiner resumes", async () => {
        const h = harness();
        const read = deferred();
        h.setNextResult(() => read.promise);
        const starter = h.resolve("a");
        const joiner = h.resolve("a");

        // Registered after the starter's and joiner's reactions: runs after the starter has cleaned up its in-flight
        // entry, but before the joiner's acceptance check resumes.
        void read.promise.then(() => h.cache.invalidate("a"));
        h.setNextResult(async () => ({ kind: "disabled" }));
        read.resolve({ kind: "active" });

        await expect(starter).resolves.toEqual({ kind: "active" });
        await expect(joiner).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("rereads for a joined caller at most once", async () => {
        const h = harness();
        const first = deferred();
        h.setNextResult(() => first.promise);
        const starter = h.resolve("a");
        const joiner = h.resolve("a");

        const second = deferred();
        h.setNextResult(() => second.promise);
        h.cache.invalidate("a");
        first.resolve({ kind: "active" });
        await expect(starter).resolves.toEqual({ kind: "active" });

        // The joiner now owns the second read; invalidating again does not send it round a third time.
        h.cache.invalidate("a");
        second.resolve({ kind: "disabled" });
        await expect(joiner).resolves.toEqual({ kind: "disabled" });
        expect(h.reads).toEqual(["a", "a"]);
    });

    it("invalidating one account leaves the others cached", async () => {
        const h = harness();
        await h.resolve("a");
        await h.resolve("b");
        h.cache.invalidate("a");
        await h.resolve("b");
        expect(h.reads).toEqual(["a", "b"]);
    });

    it("evicts the least recently used account beyond maxEntries", async () => {
        const h = harness({ maxEntries: 2 });
        await h.resolve("a");
        await h.resolve("b");
        await h.resolve("a");
        await h.resolve("c");
        expect(h.cache.size).toBe(2);
        expect(h.reads).toEqual(["a", "b", "c"]);

        await h.resolve("a");
        await h.resolve("c");
        expect(h.reads).toEqual(["a", "b", "c"]);
        await h.resolve("b");
        expect(h.reads).toEqual(["a", "b", "c", "b"]);
    });
});
