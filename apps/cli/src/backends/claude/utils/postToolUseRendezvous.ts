/** A capability for one particular pending hook response, not a delivery receipt. */
export type PendingPostToolUseResponse = Readonly<{
    offer: (message: string) => boolean;
}>;

/**
 * A single-use rendezvous. Nothing is queued for a future hook. The caller must
 * abort the wait when its HTTP response expires or disconnects. A successful
 * offer means only that this wait accepted the message, not that Claude read it.
 */
export function createPostToolUseRendezvous() {
    let pending: PendingPostToolUseResponse | undefined;

    return {
        current: (): PendingPostToolUseResponse | undefined => pending,
        wait(signal: AbortSignal): Promise<string | undefined> {
            if (signal.aborted) return Promise.resolve(undefined);
            // Parallel tool calls can fire overlapping hooks. Do not disturb the first
            // response or make the second hook fail; it must continue without output.
            if (pending) return Promise.resolve(undefined);

            return new Promise((resolve) => {
                let active = true;
                const finish = (message: string | undefined): boolean => {
                    if (!active) return false;
                    active = false;
                    signal.removeEventListener('abort', onAbort);
                    pending = undefined;
                    resolve(message);
                    return true;
                };
                const onAbort = () => { finish(undefined); };
                pending = { offer: (message) => finish(message) };
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
            });
        },
    };
}
