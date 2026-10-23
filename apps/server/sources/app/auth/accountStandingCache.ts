import type { AccountStanding } from "@/app/auth/accountStanding";

/**
 * Staleness bound for a shared account standing.
 *
 * A standing this cache hands to a caller that did not read it itself comes from a read that started less than
 * this long before the hand-over. The two ways of handing one over are fenced against invalidation differently:
 * - a remembered "active" standing is returned only before its read's start + bound, and `invalidate(accountId)`
 *   forgets that account's entry only; invalidating one account leaves other accounts' remembered entries in place;
 * - a caller that joined another caller's pending read accepts that read's result only if, at the moment it checks
 *   (after the read settles), it is still before start + bound and the cache-wide invalidation count is the one the
 *   read captured when it started, so no `invalidate` of any account happened in between. Otherwise the joiner
 *   performs one read of its own instead and returns that result.
 * A caller that started a read always receives that read's own result, as an uncached lookup would; a write that
 * commits while that read is in flight may or may not be seen, exactly as in the uncached code.
 * Writes made by another server process (multi-replica deployments) are not invalidated here; a caller is handed
 * a standing that predates such a write only if that standing's read started less than this long before.
 */
export const ACCOUNT_STANDING_CACHE_TTL_MS = 10_000;

/**
 * Upper bound on remembered "active" standings; beyond it the least recently used is forgotten. Reads in flight
 * are tracked separately, one per account with an outstanding read, and only until they settle, are displaced by
 * a newer read, or the account is invalidated.
 */
export const ACCOUNT_STANDING_CACHE_MAX_ENTRIES = 4_096;

export interface AccountStandingCacheOptions {
    readonly ttlMs: number;
    readonly maxEntries: number;
    /** Monotonic milliseconds. */
    readonly now: () => number;
}

export interface AccountStandingCache {
    /**
     * Returns the account's standing, under the contract stated on `ACCOUNT_STANDING_CACHE_TTL_MS`. Only "active"
     * is ever remembered: not-found, disabled, unavailable and rejected reads go only to the callers of that read
     * (subject to the same joiner check) and are then forgotten.
     */
    resolve(accountId: string, read: (accountId: string) => Promise<AccountStanding>): Promise<AccountStanding>;
    /**
     * Forgets the account, stops later callers joining its read in flight (that read is never remembered), and
     * advances the cache-wide invalidation count, so every caller already waiting on any shared read reads again. Call after every in-process write that can end an
     * account's active standing (including writes that fail ambiguously).
     */
    invalidate(accountId: string): void;
    /** Number of remembered active accounts. */
    readonly size: number;
}

interface InFlightRead {
    readonly startedAtMs: number;
    readonly standing: Promise<AccountStanding>;
    /** `invalidations` when the read started; any later `invalidate` makes the result unshareable. */
    readonly invalidationsAtStart: number;
}

type SettledRead =
    | { readonly ok: true; readonly standing: AccountStanding }
    | { readonly ok: false; readonly error: unknown };

const ACTIVE: AccountStanding = Object.freeze({ kind: "active" });

function requirePositiveInteger(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`AccountStandingCache ${name} must be a positive integer (got ${value})`);
    }
    return value;
}

export function createAccountStandingCache(options: AccountStandingCacheOptions): AccountStandingCache {
    const ttlMs = requirePositiveInteger("ttlMs", options.ttlMs);
    const maxEntries = requirePositiveInteger("maxEntries", options.maxEntries);
    const now = options.now;

    // accountId -> monotonic time at which its remembered "active" standing expires.
    // Map iteration order is insertion order; re-inserting on every hit makes the first key the least recently used.
    const activeUntilMs = new Map<string, number>();
    const inFlight = new Map<string, InFlightRead>();
    // Cache-wide count of `invalidate` calls. It fences joiners only: a joined pending read's result is handed over
    // only if the count has not moved since that read started (remembered entries are fenced per account by
    // `invalidate` deleting them). Being independent of map slots, the count survives a read being displaced from
    // `inFlight` or removed by its starter's cleanup before a joiner checks. Because it counts every account, an
    // invalidation makes every request joined to any read that started before it, including requests that join such
    // a still-pending read afterwards, do one read of its own: at most one extra read per affected joined request.
    // Invalidations are rare (disable, rollback delete, marker clear).
    let invalidations = 0;

    function remember(accountId: string, expiresAtMs: number): void {
        activeUntilMs.delete(accountId);
        activeUntilMs.set(accountId, expiresAtMs);
        while (activeUntilMs.size > maxEntries) {
            const leastRecentlyUsed = activeUntilMs.keys().next();
            if (leastRecentlyUsed.done) break;
            activeUntilMs.delete(leastRecentlyUsed.value);
        }
    }

    async function startRead(
        accountId: string,
        read: (accountId: string) => Promise<AccountStanding>,
        startedAtMs: number,
    ): Promise<AccountStanding> {
        const entry: InFlightRead = { startedAtMs, standing: read(accountId), invalidationsAtStart: invalidations };
        inFlight.set(accountId, entry);
        try {
            const standing = await entry.standing;
            const expiresAtMs = entry.startedAtMs + ttlMs;
            // An entry no longer registered was removed by `invalidate` or displaced by a newer read.
            if (standing.kind === "active" && inFlight.get(accountId) === entry && now() < expiresAtMs) {
                remember(accountId, expiresAtMs);
            }
            return standing;
        } finally {
            if (inFlight.get(accountId) === entry) {
                inFlight.delete(accountId);
            }
        }
    }

    return {
        async resolve(accountId, read) {
            const nowMs = now();

            const expiresAtMs = activeUntilMs.get(accountId);
            if (expiresAtMs !== undefined) {
                if (nowMs < expiresAtMs) {
                    remember(accountId, expiresAtMs);
                    return ACTIVE;
                }
                activeUntilMs.delete(accountId);
            }

            const pending = inFlight.get(accountId);
            if (pending && nowMs - pending.startedAtMs < ttlMs) {
                const settled: SettledRead = await pending.standing.then(
                    (standing) => ({ ok: true, standing }),
                    (error: unknown) => ({ ok: false, error }),
                );
                if (invalidations === pending.invalidationsAtStart && now() < pending.startedAtMs + ttlMs) {
                    if (settled.ok) return settled.standing;
                    throw settled.error;
                }
                // The joined read went stale while this caller waited: read once more, as its own reader.
                return await startRead(accountId, read, now());
            }

            return await startRead(accountId, read, nowMs);
        },
        invalidate(accountId) {
            invalidations += 1;
            activeUntilMs.delete(accountId);
            inFlight.delete(accountId);
        },
        get size() {
            return activeUntilMs.size;
        },
    };
}

/** The process-wide cache used by login-eligibility enforcement. */
export const accountStandingCache: AccountStandingCache = createAccountStandingCache({
    ttlMs: ACCOUNT_STANDING_CACHE_TTL_MS,
    maxEntries: ACCOUNT_STANDING_CACHE_MAX_ENTRIES,
    now: () => performance.now(),
});
