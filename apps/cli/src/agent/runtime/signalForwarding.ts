import type { ChildProcess } from 'node:child_process';

type SignalForwardingProcess = Pick<NodeJS.Process, 'platform' | 'on' | 'off' | 'pid' | 'kill'>;

export function attachProcessSignalForwardingToChild(
    child: ChildProcess,
    proc: SignalForwardingProcess = process,
    options: Readonly<{ beforeParentExit?: () => Promise<void> }> = {},
): void {
    const forwardSignal = (signal: NodeJS.Signals) => {
        if (child.pid && !child.killed) {
            child.kill(signal);
        }
    };

    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    if (proc.platform !== 'win32') {
        signals.push('SIGHUP');
    }

    let cleanedUp = false;
    let parentExitStarted = false;
    let owningCleanup: Promise<void> | undefined;
    const waitForOwningCleanup = (): Promise<void> => {
        owningCleanup ??= Promise.resolve().then(options.beforeParentExit);
        return owningCleanup;
    };
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        for (const [signal, handler] of handlers.entries()) {
            proc.off(signal, handler);
        }
    };

    for (const signal of signals) {
        const handler = () => {
            if (parentExitStarted) return;
            parentExitStarted = true;
            forwardSignal(signal);
            const exitParent = () => {
                cleanup();
                try {
                    proc.kill(proc.pid, signal);
                } catch {
                    // ignore
                }
            };
            if (options.beforeParentExit) {
                // Keep handlers installed while the owning caller waits for child termination
                // and finishes cleanup, including when another OS signal arrives meanwhile.
                void waitForOwningCleanup().then(exitParent, exitParent);
            } else {
                exitParent();
            }
        };
        handlers.set(signal, handler);
        proc.on(signal, handler);
    }

    const cleanupWhenNotSignaled = () => {
        if (!parentExitStarted) cleanup();
    };
    const cleanupAfterChild = () => {
        if (parentExitStarted) return;
        if (options.beforeParentExit) {
            void waitForOwningCleanup().then(cleanupWhenNotSignaled, cleanupWhenNotSignaled);
        } else {
            cleanup();
        }
    };
    child.on('exit', cleanupAfterChild);
    child.on('close', cleanupAfterChild);
    child.on('error', cleanupAfterChild);
}
