export async function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * Like {@link delay}, but calls `.unref()` on the timer so it does not keep
 * the Node.js event loop alive.  Useful in daemon/shutdown code paths where a
 * pending timer should not prevent process exit.
 */
export function delayUnref(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * Like {@link delayUnref}, but additionally resolves early (without throwing) when the given
 * signal aborts. For poll loops that re-check their abort/dispose state after every wait: the
 * pending timer neither keeps the event loop alive nor outlives an aborted session.
 */
export function delayUnrefAbortable(ms: number, abortSignal: AbortSignal): Promise<void> {
    if (abortSignal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    const safeMaxFailureCount = Number.isFinite(maxFailureCount) ? Math.max(maxFailureCount, 1) : 50;
    const clampedFailureCount = Math.min(Math.max(currentFailureCount, 0), safeMaxFailureCount);
    const maxDelayRet = minDelay + ((maxDelay - minDelay) / safeMaxFailureCount) * clampedFailureCount;
    const jittered = Math.random() * maxDelayRet;
    return Math.max(minDelay, Math.round(jittered));
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        shouldRetry?: (e: any, failuresCount: number) => boolean,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number,
        /** Optional server floor for this failed attempt; never capped by local jitter. */
        retryAfterMs?: (error: unknown) => number | undefined
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 8;
        const shouldRetry = opts && opts.shouldRetry
            ? opts.shouldRetry
            : (e: any) => {
                if (e && typeof e === 'object') {
                    if ((e as any).retryable === false) {
                        return false;
                    }
                    if (typeof (e as any).canTryAgain === 'boolean' && (e as any).canTryAgain === false) {
                        return false;
                    }
                }
                return true;
            };
        while (true) {
            try {
                return await callback();
            } catch (e) {
                currentFailureCount++;
                if (!shouldRetry(e, currentFailureCount)) {
                    throw e;
                }
                if (currentFailureCount >= maxFailureCount) {
                    throw e;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                const localDelay = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                const retryAfterMs = opts?.retryAfterMs?.(e);
                const serverDelay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
                    ? Math.max(0, Math.ceil(retryAfterMs))
                    : 0;
                await delay(Math.max(localDelay, serverDelay));
            }
        }
    };
}

export let backoff = createBackoff();
export let backoffForever = createBackoff({ maxFailureCount: Number.POSITIVE_INFINITY });
