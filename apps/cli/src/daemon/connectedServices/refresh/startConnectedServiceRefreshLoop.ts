import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { logger } from '@/ui/logger';

type ConnectedServiceRefreshLoopHandle = Readonly<{
    stop: () => void;
    pause: () => void;
    resume: () => void;
}>;

export function startConnectedServiceRefreshLoop(params: Readonly<{
    enabled: boolean;
    tickMs: number;
    coordinator: Readonly<{ tickOnce: () => Promise<void> }>;
    onTickError: (error: unknown) => void;
}>): ConnectedServiceRefreshLoopHandle | null {
    if (!params.enabled) {
        return null;
    }

    const loop: SingleFlightIntervalLoopHandle = startSingleFlightIntervalLoop({
        intervalMs: params.tickMs,
        failureBackoffMs: Math.max(params.tickMs, 5_000),
        maxFailureBackoffMs: 60_000,
        task: async () => {
            await params.coordinator.tickOnce();
        },
        onError: params.onTickError,
        onObservation: (observation) => {
            // The loop isolates sink failures from scheduling and authentication.
            logger.infoFile('[ConnectedServiceRefresh] Loop', observation);
        },
        unref: true,
    });

    loop.trigger();

    return {
        stop: () => {
            loop.stop();
        },
        pause: () => {
            loop.pause();
        },
        resume: () => {
            loop.resume();
        },
    };
}
