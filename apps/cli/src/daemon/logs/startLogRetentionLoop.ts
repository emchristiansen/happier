import { startSingleFlightIntervalLoop } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { LOG_RETENTION_INTERVAL_MS } from '@/utils/logs/logRetention';

export type LogRetentionLoopHandle = Readonly<{
  stop: () => void;
}>;

/**
 * The running daemon owns log retention (see `utils/logs/logRetention.ts`): run the retention pass
 * once at start, then every {@link LOG_RETENTION_INTERVAL_MS} on an unref'd timer until `stop()`.
 */
export function startLogRetentionLoop(params: Readonly<{
  runRetention: () => Promise<unknown>;
  onTickError: (error: unknown) => void;
}>): LogRetentionLoopHandle {
  const loop = startSingleFlightIntervalLoop({
    intervalMs: LOG_RETENTION_INTERVAL_MS,
    task: async () => {
      await params.runRetention();
    },
    onError: params.onTickError,
    unref: true,
  });

  loop.trigger();

  return {
    stop: () => loop.stop(),
  };
}
