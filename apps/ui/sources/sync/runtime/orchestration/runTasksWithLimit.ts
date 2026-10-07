export async function runTasksWithLimit<T>(
    tasks: Array<() => Promise<T>>,
    limit: number
): Promise<T[]> {
    const maxConcurrency = Math.max(1, Math.trunc(limit));
    const results: T[] = new Array(tasks.length);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= tasks.length) {
                return;
            }
            results[index] = await tasks[index]();
        }
    };

    const workersCount = Math.min(maxConcurrency, tasks.length);
    await Promise.all(Array.from({ length: workersCount }, () => worker()));
    return results;
}

export type TaskLimiter = Readonly<{
    run: <T>(task: () => Promise<T>) => Promise<T>;
}>;

export function createTaskLimiter(limit: number): TaskLimiter {
    const maxConcurrency = Math.max(1, Math.trunc(limit));
    let activeCount = 0;
    const waiters: Array<() => void> = [];

    const acquire = async (): Promise<void> => {
        if (activeCount < maxConcurrency) {
            activeCount += 1;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        activeCount += 1;
    };

    const release = (): void => {
        activeCount -= 1;
        waiters.shift()?.();
    };

    return {
        run: async <T>(task: () => Promise<T>): Promise<T> => {
            await acquire();
            try {
                return await task();
            } finally {
                release();
            }
        },
    };
}
