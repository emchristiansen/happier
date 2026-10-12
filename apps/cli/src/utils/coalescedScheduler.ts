/**
 * Provider-agnostic coalescing scheduler.
 *
 * Guarantees a single in-flight `drain()` at a time. Triggers that arrive while a drain is running
 * are collapsed into exactly one follow-up drain (latest-wins is the caller's responsibility — the
 * scheduler only coalesces invocations). Both triggers and flush barriers use this same publish
 * loop. Keep it generic: never bake provider- or workflow-specific behavior in here.
 */
export type CoalescedScheduler = Readonly<{
  /** Request a drain. Runs immediately when idle, otherwise schedules exactly one follow-up. */
  trigger(): void;
  /** Request a drain and await the active single-flight cycle reaching idle. */
  flush(): Promise<void>;
  /** Stop scheduling. Any in-flight drain finishes, but no queued follow-up runs after dispose. */
  dispose(): void;
}>;

export function createCoalescedScheduler(params: Readonly<{
  drain: () => Promise<void>;
  onError?: (error: unknown) => void;
}>): CoalescedScheduler {
  let activeRun: Promise<void> | null = null;
  let queued = false;
  let disposed = false;

  function run(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (activeRun) {
      queued = true;
      return activeRun;
    }
    // Publish the completion barrier before invoking a drain that may synchronously trigger us
    // again. Keep trigger's existing synchronous start rather than deferring the first drain.
    let resolveCycle!: () => void;
    let rejectCycle!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCycle = resolve;
      rejectCycle = reject;
    });
    activeRun = completion.finally(() => { activeRun = null; });
    const cycle = (async () => {
      try {
        do {
          queued = false;
          await params.drain();
        } while (queued && !disposed);
      } catch (error) {
        params.onError?.(error);
        throw error;
      }
    })();
    void cycle.then(resolveCycle, rejectCycle);
    return activeRun;
  }

  return Object.freeze({
    trigger() {
      // Fire-and-forget callers receive diagnostics through onError; flush callers get rejection.
      void run().catch(() => {});
    },
    flush() {
      return run();
    },
    dispose() {
      disposed = true;
      queued = false;
    },
  });
}
