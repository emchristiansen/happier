import { describe, expect, it } from 'vitest';

import { createTaskLimiter } from './runTasksWithLimit';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('createTaskLimiter', () => {
    it('transfers capacity to the oldest waiter before a competing arrival', async () => {
        const limiter = createTaskLimiter(1);
        const first = deferred();
        const firstStarted = deferred();
        const second = deferred();
        const secondStarted = deferred();
        const third = deferred();
        const started: string[] = [];

        const firstRun = limiter.run(() => {
            firstStarted.resolve();
            return first.promise;
        });
        await firstStarted.promise;
        const secondRun = limiter.run(() => {
            started.push('second');
            secondStarted.resolve();
            return second.promise;
        });
        let thirdRun!: Promise<void>;
        first.resolve();
        queueMicrotask(() => {
            thirdRun = limiter.run(() => {
                started.push('third');
                return third.promise;
            });
        });

        try {
            await firstRun;
            await secondStarted.promise;
            await Promise.resolve();
            expect(started).toEqual(['second']);
        } finally {
            second.resolve();
            third.resolve();
            await Promise.all([secondRun, thirdRun]);
        }
        expect(started).toEqual(['second', 'third']);
    });

    it('transfers capacity after a rejected task', async () => {
        const limiter = createTaskLimiter(1);
        const failure = new Error('task failed');
        const firstRun = limiter.run(() => Promise.reject(failure));
        const secondRun = limiter.run(() => Promise.resolve('next'));

        await expect(firstRun).rejects.toBe(failure);
        await expect(secondRun).resolves.toBe('next');
    });

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
