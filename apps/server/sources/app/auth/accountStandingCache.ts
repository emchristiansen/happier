import type { AccountStanding } from "@/app/auth/accountStanding";

/**
 * Staleness bound for a cached "active" standing.
 *
 * Every login-eligibility decision that uses this cache rests on an account read that started at most
 * this long before the decision, and after the most recent in-process `invalidate` of that account.
 * Writes made by another server process (multi-replica deployments) take effect within this bound.
 */
export const ACCOUNT_STANDING_CACHE_TTL_MS = 10_000;

/** Upper bound on remembered accounts; beyond it the least recently used account is forgotten. */
export const ACCOUNT_STANDING_CACHE_MAX_ENTRIES = 4_096;

export interface AccountStandingCacheOptions {
    readonly ttlMs: number;
    readonly maxEntries: number;
    /** Monotonic milliseconds. */
    readonly now: () => number;
}

export interface AccountStandingCache {
    /**
     * Returns the account's standing, reading it with `read` unless an "active" standing read within the bound
     * is remembered. Concurrent callers share one read that started within the bound. Only "active" is ever
     * remembered: not-found, disabled, unavailable and rejected reads are returned to the callers that shared
     * that read and then forgotten.
     */
    resolve(accountId: string, read: (accountId: string) => Promise<AccountStanding>): Promise<AccountStanding>;
    /**
     * Forgets the account and detaches any read in flight for it, so that read is never remembered and later
     * callers start a new one. Call after every in-process write that can end an account's active standing.
     */
    invalidate(accountId: string): void;
    /** Number of remembered active accounts. */
    readonly size: number;
}

interface InFlightRead {
    readonly startedAtMs: number;
    readonly standing: Promise<AccountStanding>;
}

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
        const entry: InFlightRead = { startedAtMs, standing: read(accountId) };
        inFlight.set(accountId, entry);
        try {
            const standing = await entry.standing;
            const expiresAtMs = entry.startedAtMs + ttlMs;
            // An entry no longer registered was invalidated (or superseded by a newer read) while in flight.
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
                return await pending.standing;
            }

            return await startRead(accountId, read, nowMs);
        },
        invalidate(accountId) {
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
