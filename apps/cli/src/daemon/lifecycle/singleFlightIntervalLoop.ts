export type SingleFlightIntervalLoopHandle = Readonly<{
  stop: () => void;
  trigger: () => void;
  pause: () => void;
  resume: () => void;
}>;

export type SingleFlightIntervalLoopObservation = Readonly<{
  event: 'started' | 'completed' | 'skipped' | 'paused' | 'resumed' | 'stopped';
  stopped: boolean;
  paused: boolean;
  inFlight: boolean;
  elapsedMs: number;
  reason?: 'stopped' | 'paused' | 'in_flight' | 'failure_backoff';
  outcome?: 'success' | 'failure';
}>;

export function startSingleFlightIntervalLoop(args: Readonly<{
  intervalMs: number;
  task: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  unref?: boolean;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  onObservation?: (observation: SingleFlightIntervalLoopObservation) => void;
}>): SingleFlightIntervalLoopHandle {
  let stopped = false;
  let inFlight = false;
  let paused = false;
  let failureCount = 0;
  let nextAutomaticRunAtMs = 0;
  let startedAtMs: number | null = null;
  const intervalMs = Math.max(1, Math.floor(args.intervalMs));
  const failureBackoffMs = Math.max(0, Math.floor(args.failureBackoffMs ?? 0));
  const maxFailureBackoffMs = Math.max(
    failureBackoffMs,
    Math.floor(args.maxFailureBackoffMs ?? failureBackoffMs),
  );

  const observe = (event: SingleFlightIntervalLoopObservation['event'], detail: Readonly<{
    reason?: SingleFlightIntervalLoopObservation['reason'];
    outcome?: SingleFlightIntervalLoopObservation['outcome'];
  }> = {}) => {
    if (!args.onObservation) return;
    try {
      args.onObservation({
        event, stopped, paused, inFlight,
        elapsedMs: startedAtMs === null ? 0 : Math.max(0, Date.now() - startedAtMs),
        ...detail,
      });
    } catch {
      // Diagnostics must never change task ownership, retries, or lifecycle state.
    }
  };

  const runOnce = (options: Readonly<{ force?: boolean }> = {}) => {
    if (stopped) { observe('skipped', { reason: 'stopped' }); return; }
    if (paused) { observe('skipped', { reason: 'paused' }); return; }
    if (inFlight) { observe('skipped', { reason: 'in_flight' }); return; }
    if (!options.force && failureBackoffMs > 0 && Date.now() < nextAutomaticRunAtMs) {
      observe('skipped', { reason: 'failure_backoff' }); return;
    }

    inFlight = true;
    startedAtMs = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    observe('started');
    Promise.resolve()
      .then(() => args.task())
      .then(() => {
        failureCount = 0;
        nextAutomaticRunAtMs = 0;
      })
      .catch((error) => {
        outcome = 'failure';
        if (failureBackoffMs > 0) {
          const multiplier = Math.max(1, 2 ** failureCount);
          const delayMs = Math.min(maxFailureBackoffMs, failureBackoffMs * multiplier);
          failureCount += 1;
          nextAutomaticRunAtMs = Date.now() + delayMs;
        }
        args.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
        observe('completed', { outcome });
        startedAtMs = null;
      });
  };

  const timer = setInterval(runOnce, intervalMs);
  if (args.unref === true) {
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      observe('stopped');
    },
    trigger: () => {
      runOnce({ force: true });
    },
    pause: () => {
      paused = true;
      observe('paused');
    },
    resume: () => {
      paused = false;
      observe('resumed');
    },
  };
}
