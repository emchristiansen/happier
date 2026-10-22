import { startSingleFlightIntervalLoop } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { SESSION_LOG_SWEEP_INTERVAL_MS } from '@/utils/logs/logRetention';

export type SessionLogRetentionLoopHandle = Readonly<{
  stop: () => void;
}>;

/**
 * The daemon owns session-log retention (see `utils/logs/logRetention.ts`): sweep once at start,
 * then every {@link SESSION_LOG_SWEEP_INTERVAL_MS} on an unref'd timer until `stop()`.
 */
export function startSessionLogRetentionLoop(params: Readonly<{
  sweep: () => Promise<unknown>;
  onTickError: (error: unknown) => void;
}>): SessionLogRetentionLoopHandle {
  const loop = startSingleFlightIntervalLoop({
    intervalMs: SESSION_LOG_SWEEP_INTERVAL_MS,
    task: async () => {
      await params.sweep();
    },
    onError: params.onTickError,
    unref: true,
  });

  loop.trigger();

  return {
    stop: () => loop.stop(),
  };
}
