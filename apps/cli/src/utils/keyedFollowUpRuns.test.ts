import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';

import { createKeyedFollowUpRuns, type KeyedFollowUpRunContext } from './keyedFollowUpRuns';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function createHarness() {
  const runs: Array<KeyedFollowUpRunContext<string, string> & {
    deferred: ReturnType<typeof createDeferred<string>>;
  }> = [];
  const queue = createKeyedFollowUpRuns<string, string, string>({
    run: async (context) => {
      const deferred = createDeferred<string>();
      runs.push({ ...context, deferred });
      return await deferred.promise;
    },
  });
  return { runs, queue };
}

describe('createKeyedFollowUpRuns', () => {
  it.each(['fulfilled', 'rejected'] as const)(
    'runs each cohort in its first requester’s context after the active run %s',
    async (settlement) => {
      const caller = new AsyncLocalStorage<string>();
      const seen: Array<string | undefined> = [];
      const runs: Array<ReturnType<typeof createDeferred<string>>> = [];
      const queue = createKeyedFollowUpRuns<string, string, string>({
        run: async () => {
          seen.push(caller.getStore());
          const run = createDeferred<string>();
          runs.push(run);
          return await run.promise;
        },
      });
      const initial = caller.run('initial', () => queue.request('target', 'initial', { requireStartAfterRequest: false }));
      void initial.catch(() => {});
      await flushMicrotasks();
      const forced = caller.run('first-forced', () => queue.request('target', 'first', { requireStartAfterRequest: true }));
      const joined = caller.run('later-forced', () => queue.request('target', 'later', { requireStartAfterRequest: true }));
      expect(joined).toBe(forced);
      if (settlement === 'fulfilled') runs[0]!.resolve('initial');
      else runs[0]!.reject(new Error('initial failed'));
      await initial.catch(() => {});
      await flushMicrotasks();
      const next = caller.run('next-cohort', () => queue.request('target', 'next', { requireStartAfterRequest: true }));
      runs[1]!.resolve('forced');
      await forced;
      await flushMicrotasks();
      runs[2]!.resolve('next');
      await next;
      expect(seen).toEqual(['initial', 'first-forced', 'next-cohort']);
    },
  );

  it('queues exactly one follow-up for any number of start-after requests during an active run', async () => {
    const { runs, queue } = createHarness();
    const first = queue.request('target', 'r1', { requireStartAfterRequest: true });
    await flushMicrotasks();
    const waiters = ['r2', 'r3', 'r4', 'r5'].map((input) => (
      queue.request('target', input, { requireStartAfterRequest: true })
    ));
    await flushMicrotasks();
    expect(runs).toHaveLength(1);

    runs[0]!.deferred.resolve('run-1');
    await expect(first).resolves.toBe('run-1');
    await flushMicrotasks();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      kind: 'follow_up',
      inputs: ['r2', 'r3', 'r4', 'r5'],
      servesStartAfterRequest: true,
    });

    runs[1]!.deferred.resolve('run-2');
    await expect(Promise.all(waiters)).resolves.toEqual(['run-2', 'run-2', 'run-2', 'run-2']);
    await flushMicrotasks();
    expect(runs).toHaveLength(2);
  });

  it('lets a request that does not need a later start join the active run', async () => {
    const { runs, queue } = createHarness();
    const first = queue.request('target', 'forced', { requireStartAfterRequest: true });
    await flushMicrotasks();
    const joined = queue.request('target', 'passive', { requireStartAfterRequest: false });
    expect(joined).toBe(first);

    runs[0]!.deferred.resolve('run-1');
    await expect(joined).resolves.toBe('run-1');
    await flushMicrotasks();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'initial', inputs: ['forced'] });
  });

  it('starts the follow-up only after the active run settles, including when it rejects', async () => {
    const { runs, queue } = createHarness();
    const first = queue.request('target', 'passive', { requireStartAfterRequest: false });
    await flushMicrotasks();
    const forced = queue.request('target', 'forced', { requireStartAfterRequest: true });
    await flushMicrotasks();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.servesStartAfterRequest).toBe(false);

    runs[0]!.deferred.reject(new Error('active failed'));
    await expect(first).rejects.toThrow('active failed');
    await flushMicrotasks();
    expect(runs).toHaveLength(2);

    runs[1]!.deferred.reject(new Error('follow-up failed'));
    await expect(forced).rejects.toThrow('follow-up failed');
  });

  it('queues a new follow-up for requests that arrive while the previous follow-up is running', async () => {
    const { runs, queue } = createHarness();
    void queue.request('target', 'r1', { requireStartAfterRequest: true });
    await flushMicrotasks();
    const second = queue.request('target', 'r2', { requireStartAfterRequest: true });
    runs[0]!.deferred.resolve('run-1');
    await flushMicrotasks();
    expect(runs).toHaveLength(2);

    const third = queue.request('target', 'r3', { requireStartAfterRequest: true });
    await flushMicrotasks();
    expect(runs).toHaveLength(2);
    runs[1]!.deferred.resolve('run-2');
    await expect(second).resolves.toBe('run-2');
    await flushMicrotasks();
    expect(runs).toHaveLength(3);
    expect(runs[2]!.inputs).toEqual(['r3']);
    runs[2]!.deferred.resolve('run-3');
    await expect(third).resolves.toBe('run-3');
  });

  it('keeps keys independent', async () => {
    const { runs, queue } = createHarness();
    void queue.request('a', 'a1', { requireStartAfterRequest: true });
    void queue.request('b', 'b1', { requireStartAfterRequest: true });
    await flushMicrotasks();
    expect(runs.map((run) => run.key)).toEqual(['a', 'b']);
    runs[0]!.deferred.resolve('a');
    runs[1]!.deferred.resolve('b');
  });

  it('returns to idle after the last run settles', async () => {
    const { runs, queue } = createHarness();
    const first = queue.request('target', 'r1', { requireStartAfterRequest: true });
    await flushMicrotasks();
    runs[0]!.deferred.resolve('run-1');
    await first;
    await flushMicrotasks();

    const next = queue.request('target', 'r2', { requireStartAfterRequest: true });
    await flushMicrotasks();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ kind: 'initial', inputs: ['r2'] });
    runs[1]!.deferred.resolve('run-2');
    await expect(next).resolves.toBe('run-2');
  });
});
