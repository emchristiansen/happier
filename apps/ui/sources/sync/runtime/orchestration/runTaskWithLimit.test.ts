import { describe, expect, it } from 'vitest';

import { createTaskLimiter } from './runTasksWithLimit';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('createTaskLimiter', () => {
    it('holds capacity until the real operation settles even when a caller stops waiting', async () => {
        const limiter = createTaskLimiter(1);
        const first = deferred();
        let secondStarted = false;

        const firstRun = limiter.run(async () => first.promise);
        const secondRun = limiter.run(async () => { secondStarted = true; });
        await Promise.resolve();
        expect(secondStarted).toBe(false);

        first.resolve();
        await firstRun;
        await secondRun;
        expect(secondStarted).toBe(true);
    });
});
