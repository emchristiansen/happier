import type { ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';

export type ConnectedServiceQuotasLoopHandle = Readonly<{
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  wake: (sources?: readonly ConnectedServiceUsageSourceV1[]) => void;
}>;

export function startConnectedServiceQuotasLoop(params: Readonly<{
  enabled: boolean;
  tickMs: number;
  tickJitterMs?: number;
  random?: () => number;
  coordinator: Readonly<{
    tickOnce: () => Promise<void>;
    scheduleCurrentSourceRefresh?: (sources: readonly ConnectedServiceUsageSourceV1[]) => unknown;
  }>;
  onTickError: (error: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}>): ConnectedServiceQuotasLoopHandle | null {
  if (!params.enabled) return null;

  const tickMs = Math.max(1, Math.trunc(params.tickMs));
  const tickJitterMs =
    typeof params.tickJitterMs === 'number' && Number.isFinite(params.tickJitterMs)
      ? Math.max(0, Math.trunc(params.tickJitterMs))
      : 0;
  const random = params.random ?? Math.random;
  const computeDelayMs = (): number => {
    if (tickJitterMs <= 0) return tickMs;
    const raw = random();
    const normalized = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    return tickMs + Math.trunc(normalized * tickJitterMs);
  };
  const setIntervalImpl = params.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    params.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));
  const setTimeoutImpl = params.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl =
    params.clearTimeoutFn ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let paused = false;
  let wakeRequested = false;
  let timeoutHandle: unknown = null;
  const usesTimeout = tickJitterMs > 0 || Boolean(params.setTimeoutFn || params.clearTimeoutFn);
  const scheduleNext = (): void => {
    if (stopped || !usesTimeout) return;
    timeoutHandle = setTimeoutImpl(() => {
      timeoutHandle = null;
      runTick();
    }, computeDelayMs());
    (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
  };
  const runTick = (): void => {
    if (stopped) return;
    if (inFlight || paused) {
      if (timeoutHandle === null && !inFlight) scheduleNext();
      return;
    }
    wakeRequested = false;
    if (timeoutHandle !== null) {
      clearTimeoutImpl(timeoutHandle);
      timeoutHandle = null;
    }
    inFlight = (async () => {
      try {
        await params.coordinator.tickOnce();
      } catch (error) {
        params.onTickError(error);
      } finally {
        inFlight = null;
        if (wakeRequested && !paused) runTick();
        else scheduleNext();
      }
    })();
  };
  const wake = (sources: readonly ConnectedServiceUsageSourceV1[] = []): void => {
    if (stopped) return;
    if (sources.length > 0) params.coordinator.scheduleCurrentSourceRefresh?.(sources);
    wakeRequested = true;
    runTick();
  };
  const waitForInFlight = async (): Promise<void> => {
    const pending = inFlight;
    if (pending) await pending;
  };
  if (usesTimeout) {
    scheduleNext();

    return {
      stop: async () => {
        if (stopped) {
          await waitForInFlight();
          return;
        }
        stopped = true;
        if (timeoutHandle !== null) {
          clearTimeoutImpl(timeoutHandle);
          timeoutHandle = null;
        }
        await waitForInFlight();
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        if (wakeRequested) runTick();
      },
      wake,
    };
  }

  const intervalHandle = setIntervalImpl(runTick, tickMs);
  (intervalHandle as unknown as { unref?: () => void })?.unref?.();

  return {
    stop: async () => {
      if (stopped) {
        await waitForInFlight();
        return;
      }
      stopped = true;
      clearIntervalImpl(intervalHandle);
      await waitForInFlight();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      if (wakeRequested) runTick();
    },
    wake,
  };
}
