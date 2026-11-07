import { describe, expect, it } from 'vitest';

import { createCoalescedScheduler } from './coalescedScheduler';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createCoalescedScheduler', () => {
  it('coalesces a synchronous trigger from the active drain without starting a competing drain', async () => {
    let drains = 0;
    const gate = deferred();
    const scheduler = createCoalescedScheduler({
      drain: async () => {
        drains += 1;
        if (drains === 1) {
          scheduler.trigger();
          await gate.promise;
        }
      },
    });
    const flush = scheduler.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drainsBeforeRelease = drains;
    gate.resolve();
    await flush;
    expect(drainsBeforeRelease).toBe(1);
    expect(drains).toBe(2);
  });

  it('rejects a flush barrier when its drain fails and remains usable for a later flush', async () => {
    const failure = new Error('metadata write failed');
    const errors: unknown[] = [];
    let available = false;
    const scheduler = createCoalescedScheduler({
      drain: async () => { if (!available) throw failure; },
      onError: (error) => { errors.push(error); },
    });
    await expect(scheduler.flush()).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    available = true;
    await expect(scheduler.flush()).resolves.toBeUndefined();
  });

  it('runs a single drain per trigger when idle', async () => {
    let drains = 0;
    const scheduler = createCoalescedScheduler({
      drain: async () => {
        drains += 1;
      },
    });
    scheduler.trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(1);
  });

  it('coalesces triggers that arrive while a drain is in flight into exactly one re-run', async () => {
    let drains = 0;
    const gate = deferred();
    const scheduler = createCoalescedScheduler({
      drain: async () => {
        drains += 1;
        if (drains === 1) await gate.promise;
      },
    });

    scheduler.trigger(); // starts drain #1 (awaiting gate)
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(1);

    // Three triggers while drain #1 is in flight must coalesce into ONE re-run.
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(2);
  });

  it('routes drain errors to onError and keeps the scheduler usable', async () => {
    const errors: unknown[] = [];
    let drains = 0;
    const scheduler = createCoalescedScheduler({
      drain: async () => {
        drains += 1;
        if (drains === 1) throw new Error('boom');
      },
      onError: (error) => errors.push(error),
    });

    scheduler.trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);

    scheduler.trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(2);
  });

  it('stops re-running after dispose', async () => {
    let drains = 0;
    const gate = deferred();
    const scheduler = createCoalescedScheduler({
      drain: async () => {
        drains += 1;
        if (drains === 1) await gate.promise;
      },
    });
    scheduler.trigger();
    await new Promise((r) => setTimeout(r, 0));
    scheduler.trigger(); // queued
    scheduler.dispose();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(1);
  });
});
