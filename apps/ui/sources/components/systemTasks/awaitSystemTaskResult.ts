import type { SystemTaskResult } from '@happier-dev/protocol';

import type { SystemTaskRunner } from './types';

/**
 * Resolve when a started system task settles.
 *
 * The runner replays a result that already arrived to a late subscriber, so subscribing after
 * `start()` cannot miss it; the guard here is only against a listener that fires synchronously
 * during `subscribe`, which would otherwise leave an unsubscribe nobody called.
 *
 * One owner for every caller that starts a local task and needs its outcome — the desktop setup
 * coordinator's proof reads and the background-service commands both wait here rather than each
 * wrapping the same subscription.
 */
export function awaitSystemTaskResult(runner: SystemTaskRunner, taskId: string): Promise<SystemTaskResult> {
    return new Promise((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let settled = false;
        const settle = (result: SystemTaskResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
            unsubscribe?.();
        };
        unsubscribe = runner.subscribe(taskId, undefined, settle);
        if (settled) {
            unsubscribe();
        }
    });
}
