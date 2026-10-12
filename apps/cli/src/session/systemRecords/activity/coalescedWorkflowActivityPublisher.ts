import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import { isPermanentRequestError } from '@/api/client/httpStatusError';
import { createCoalescedScheduler } from '@/utils/coalescedScheduler';

import type { WorkflowActivityObservationLike } from './workflowActivityObservation';
import type { WorkflowActivityPublisher } from './publishWorkflowActivitySnapshot';

/**
 * Coalescing/scheduling wrapper around the per-run workflow activity publisher (CWF3).
 *
 * The single choke point for write-rate control. It reuses the generic `createCoalescedScheduler`
 * (one in-flight drain, follow-up coalesced) and layers workflow-specific semantics on top:
 *
 * - Debounce progress-only updates with a latest-wins delay so a progress burst becomes one write.
 * - Bypass the debounce and publish immediately on UX-relevant transitions: run start, status-class
 *   change, or terminal status — so the UI discovers runs and terminal outcomes promptly.
 * - Accumulate changed run ids across notifies so the eventual publish carries every dirty run.
 * - `flush()` drains pending work immediately (terminal flush / stream close / session finalization).
 * - `dispose()` stops scheduling.
 *
 * Per-run fingerprint/no-op suppression already lives upstream in the tracker, which reports
 * `changedRunIds` only for material changes, so this layer never needs to diff snapshots; an empty
 * change set is simply a no-op. The durable publisher owns record revisions.
 */
export type CoalescedWorkflowActivityPublisher = Readonly<{
  /** Record a tracker observation. Triggers an immediate or debounced publish. */
  notify(observation: WorkflowActivityObservationLike): void;
  /** Drain any pending changes immediately (terminal/stream-close/shutdown). */
  flush(): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createCoalescedWorkflowActivityPublisher(params: Readonly<{
  publisher: WorkflowActivityPublisher;
  getSnapshots: () => ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}>): CoalescedWorkflowActivityPublisher {
  const debounceMs = params.debounceMs ?? 300;
  const pendingChangedRunIds = new Set<string>();
  // Failed attempts are delayed work, not fresh observations for flush() to drain immediately.
  const pendingRetryRunIds = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let activeFlushes = 0;
  const runPublishDrain = async (): Promise<void> => {
    if (disposed) return;
    if (pendingChangedRunIds.size === 0) return;
    const changedRunIds = [...pendingChangedRunIds];
    pendingChangedRunIds.clear();
    try {
      const result = await params.publisher.publish({
        snapshots: params.getSnapshots(),
        changedRunIds,
      });
      scheduleRetry(result.failedRunIds);
    } catch (error) {
      // A drain-level throw is the headline write (or an unexpected fault), so the run partition
      // the publisher computes never happened. The SAME rule decides it: a refusal the server will
      // repeat is dropped rather than re-queued, or this becomes a debounce-interval write loop for
      // the session's lifetime. New evidence still produces a fresh attempt via `notify`.
      if (!isPermanentRequestError(error)) scheduleRetry(changedRunIds);
      throw error;
    }
  };

  const scheduler = createCoalescedScheduler({
    drain: runPublishDrain,
    onError: params.onError,
  });

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function triggerNow(): void {
    clearDebounce();
    takePendingRetries();
    scheduler.trigger();
  }

  function takePendingRetries(): void {
    for (const runId of pendingRetryRunIds) pendingChangedRunIds.add(runId);
    pendingRetryRunIds.clear();
  }

  function scheduleDebounce(): void {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      takePendingRetries();
      scheduler.trigger();
    }, debounceMs);
  }

  function scheduleRetry(runIds: readonly string[]): void {
    if (disposed || runIds.length === 0) return;
    for (const runId of runIds) pendingRetryRunIds.add(runId);
    scheduleDebounce();
  }

  function notify(observation: WorkflowActivityObservationLike): void {
    if (disposed) return;
    for (const runId of observation.changedRunIds) pendingChangedRunIds.add(runId);
    if (pendingChangedRunIds.size === 0) return;

    const immediate =
      observation.startedRunIds.length > 0
      || observation.statusChangedRunIds.length > 0
      || observation.terminalRunIds.length > 0;

    if (immediate || activeFlushes > 0) {
      triggerNow();
      return;
    }
    // Progress-only: latest-wins debounce.
    scheduleDebounce();
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    clearDebounce();
    takePendingRetries();
    // The scheduler owns every drain, including this barrier. It awaits in-flight writes and
    // terminal observations queued behind them without a competing direct publish loop. Failures
    // stay on the delayed retry path instead of becoming immediate flush retries.
    activeFlushes += 1;
    try {
      await scheduler.flush();
    } finally {
      activeFlushes -= 1;
    }
  }

  function dispose(): void {
    disposed = true;
    clearDebounce();
    pendingChangedRunIds.clear();
    pendingRetryRunIds.clear();
    scheduler.dispose();
  }

  return { notify, flush, dispose };
}
