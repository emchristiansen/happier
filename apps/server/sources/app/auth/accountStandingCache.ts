import type { AccountStanding } from "@/app/auth/accountStanding";

/**
 * Staleness bound for a shared account standing.
 *
 * A standing this cache hands to a caller that did not read it itself comes from a read that started less than
 * this long before the hand-over, and that no in-process `invalidate` of the account detached in the meantime:
 * - a remembered "active" standing is returned only before its read's start + bound;
 * - a caller that joined another caller's read accepts that read's result only if, when it settles, it is still
 *   before start + bound and not detached; otherwise the joiner performs one read of its own instead.
 * A caller that started a read always receives that read's own result, as an uncached lookup would; a write that
 * commits while that read is in flight may or may not be seen, exactly as in the uncached code.
 * Writes made by another server process (multi-replica deployments) are not invalidated here; a caller is handed
 * a standing that predates such a write only if that standing's read started less than this long before.
 */
export const ACCOUNT_STANDING_CACHE_TTL_MS = 10_000;

/**
 * Upper bound on remembered "active" standings; beyond it the least recently used is forgotten. Reads in flight
 * are tracked separately, one per account with an outstanding read, and only until they settle or are detached.
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
     * Forgets the account and detaches any read in flight for it: that read is never remembered, callers that had
     * joined it read again, and later callers start a new read. Call after every in-process write that can end an
     * account's active standing (including writes that fail ambiguously).
     */
    invalidate(accountId: string): void;
    /** Number of remembered active accounts. */
    readonly size: number;
}

interface InFlightRead {
    readonly startedAtMs: number;
    readonly standing: Promise<AccountStanding>;
    /** Set by `invalidate` while the read is in flight. */
    detached: boolean;
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
        const entry: InFlightRead = { startedAtMs, standing: read(accountId), detached: false };
        inFlight.set(accountId, entry);
        try {
            const standing = await entry.standing;
            const expiresAtMs = entry.startedAtMs + ttlMs;
            // An entry no longer registered was detached by `invalidate` or superseded by a newer read.
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
                if (!pending.detached && now() < pending.startedAtMs + ttlMs) {
                    if (settled.ok) return settled.standing;
                    throw settled.error;
                }
                // The joined read went stale while this caller waited: read once more, as its own reader.
                return await startRead(accountId, read, now());
            }

            return await startRead(accountId, read, nowMs);
        },
        invalidate(accountId) {
            activeUntilMs.delete(accountId);
            const pending = inFlight.get(accountId);
            if (pending) {
                pending.detached = true;
                inFlight.delete(accountId);
            }
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
