import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { createHttpStatusError } from '@/api/client/httpStatusError';

import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher';
import type { WorkflowActivityPublishInput } from './publishWorkflowActivitySnapshot';
import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot';

function runSnapshot(runId: string, status: SessionWorkflowRunSnapshotV1['status'] = 'active'): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId,
    backendId: 'claude',
    title: `Run ${runId}`,
    status,
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [],
    agents: [],
  };
}

describe('createCoalescedWorkflowActivityPublisher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const publishes: WorkflowActivityPublishInput[] = [];
    const publisher = { publish: vi.fn(async (input: WorkflowActivityPublishInput) => { publishes.push(input); return { failedRunIds: [], permanentFailedRunIds: [] }; }) };
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')], ['b', runSnapshot('b')]]),
      debounceMs: 300,
    });
    return { publishes, publisher, scheduler };
  }

  it('debounces progress-only updates into a single publish after the delay', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes immediately on a run start (bypasses the debounce)', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes immediately on a status change and on a terminal run', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: ['a'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('accumulates changed run ids across notifies and forwards them to the publisher', async () => {
    const { publishes, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.notify({ changedRunIds: ['b'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(publishes).toHaveLength(1);
    expect([...publishes[0].changedRunIds].sort()).toEqual(['a', 'b']);
  });

  it('flush() publishes pending changes synchronously-ish without waiting for the debounce', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    await scheduler.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('requeues failed run ids returned by the publisher for a delayed retry', async () => {
    const publishes: WorkflowActivityPublishInput[] = [];
    let attempt = 0;
    const publisher = {
      publish: vi.fn(async (input: WorkflowActivityPublishInput) => {
        publishes.push(input);
        attempt += 1;
        return { failedRunIds: attempt === 1 ? ['a'] : [], permanentFailedRunIds: [] };
      }),
    };
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')]]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publishes[1]?.changedRunIds).toEqual(['a']);
  });

  it('flush leaves failed durable writes on the delayed retry path instead of retrying in a tight loop', async () => {
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: string[][] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (!available) throw createHttpStatusError(500, 'Unavailable');
      },
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow.activeRuns.map((run) => run.runId)); },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')]]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await scheduler.flush();
    expect(records).toHaveLength(1);
    expect(headlines).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(299);
    expect(records).toHaveLength(1);

    available = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(records).toHaveLength(2);
    expect(headlines).toEqual([[], ['a']]);
    scheduler.dispose();
  });

  it('flush waits for an in-flight write and drains new terminal observations arriving during it', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let firstAttempt = true;
    const headlines: string[][] = [];
    const snapshots = new Map([['a', runSnapshot('a')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async () => {
        if (firstAttempt) {
          firstAttempt = false;
          await firstWrite;
        }
      },
      writeHeadlines: (bundle) => {
        headlines.push((bundle.workflow.recentRuns ?? []).map((run) => run.runId));
      },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    snapshots.set('a', runSnapshot('a', 'complete'));
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    let flushed = false;
    const flush = scheduler.flush().then(() => { flushed = true; });
    expect(flushed).toBe(false);
    releaseFirstWrite();
    await flush;
    expect(headlines.at(-1)).toEqual(['a']);
    scheduler.dispose();
  });

  it.each(['active', 'complete'] as const)('serializes a %s notification arriving during a flush-driven record write', async (status) => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: string[][] = [];
    const snapshots = new Map([['a', runSnapshot('a')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (records.length === 1) await firstWrite;
      },
      writeHeadlines: (bundle) => { headlines.push((bundle.workflow.recentRuns ?? []).map((run) => run.runId)); },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    const flush = scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    snapshots.set('a', { ...runSnapshot('a', status), updatedAt: 2000, totalAgents: 2 });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: status === 'complete' ? ['a'] : [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    const writesBeforeRelease = records.length;
    releaseFirstWrite();
    await flush;
    expect(writesBeforeRelease).toBe(1);
    expect(records.map((record) => record.status)).toEqual(['active', status]);
    expect(headlines.at(-1)).toEqual(status === 'complete' ? ['a'] : []);
    scheduler.dispose();
  });

  it('re-queues a drain that threw a retryable error, and drops one the server refused permanently', async () => {
    // The whole-drain catch covers the headline write, which is a separate request from the per-run
    // records. A 503 there is worth another attempt; a 400/403 is the same bytes being refused
    // again, and re-queueing it is a 300 ms metadata-write loop for the session's lifetime.
    for (const testCase of [
      { error: createHttpStatusError(503, 'Busy'), expectedPublishes: 2 },
      { error: createHttpStatusError(400, 'Invalid parameters'), expectedPublishes: 1 },
    ]) {
      const publisher = {
        publish: vi.fn(async () => { throw testCase.error; }),
      };
      const scheduler = createCoalescedWorkflowActivityPublisher({
        publisher,
        getSnapshots: () => new Map([['a', runSnapshot('a')]]),
        debounceMs: 300,
        onError: () => {},
      });

      scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(publisher.publish).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300);

      expect(publisher.publish).toHaveBeenCalledTimes(testCase.expectedPublishes);
      scheduler.dispose();
    }
  });

  it('does nothing when notified with no changed runs', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('stops publishing after dispose', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
