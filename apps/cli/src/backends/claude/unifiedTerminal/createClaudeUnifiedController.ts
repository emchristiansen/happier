import type {
  ClaudeUnifiedDisposable,
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedStartableDisposable,
  ClaudeUnifiedTerminalHost,
} from './_types';
import type { TerminalHostLiveness } from '@/agent/runtime/terminal/_types';

export class ClaudeUnifiedTerminalHostDeadError extends Error {
  readonly code = 'claude_unified_terminal_host_dead';
  readonly liveness: TerminalHostLiveness | undefined;

  constructor(liveness?: TerminalHostLiveness | undefined) {
    super('Claude unified terminal host is not alive');
    this.name = 'ClaudeUnifiedTerminalHostDeadError';
    this.liveness = liveness;
  }
}

export function isClaudeUnifiedTerminalHostDeadError(
  error: unknown,
): error is ClaudeUnifiedTerminalHostDeadError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_host_dead';
}

export type ClaudeUnifiedController = Readonly<{
  run(): Promise<void>;
  dispose(): Promise<void>;
}>;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createClaudeUnifiedController(opts: Readonly<{
  host: ClaudeUnifiedTerminalHost;
  pendingQueuePump: ClaudeUnifiedStartableDisposable;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'dispose'>;
  observerBridge?: ClaudeUnifiedStartableDisposable | undefined;
  transcriptBridge?: ClaudeUnifiedStartableDisposable | undefined;
  onFatalError?: ((error: unknown) => void) | undefined;
  onDisposeError?: ((error: unknown) => void) | undefined;
  initialLivenessTimeoutMs?: number | undefined;
  initialLivenessPollMs?: number | undefined;
  nowMs?: (() => number) | undefined;
}>): ClaudeUnifiedController {
  const abortController = new AbortController();
  let disposed = false;
  let running = false;
  const initialLivenessTimeoutMs = Math.max(0, Math.trunc(opts.initialLivenessTimeoutMs ?? 0));
  const initialLivenessPollMs = Math.max(1, Math.trunc(opts.initialLivenessPollMs ?? 50));
  const nowMs = opts.nowMs ?? Date.now;

  const disposeOne = async (disposable: ClaudeUnifiedDisposable | null | undefined): Promise<void> => {
    try {
      await Promise.resolve(disposable?.dispose());
    } catch (error) {
      opts.onDisposeError?.(error);
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    abortController.abort('claude-unified-controller-dispose');
    await disposeOne(opts.pendingQueuePump);
    await disposeOne(opts.transcriptBridge);
    await disposeOne(opts.observerBridge);
    await disposeOne(opts.arbiter);
    await disposeOne({ dispose: opts.host.preserve });
  };

  const handleSupervisedFailure = (error: unknown): void => {
    if (disposed) return;
    opts.onFatalError?.(error);
    abortController.abort(error);
  };

  const startSupervised = (
    startable: ClaudeUnifiedStartableDisposable | null | undefined,
  ): void => {
    if (!startable) return;
    const started = startable.start({ abortSignal: abortController.signal });
    void Promise.resolve(started).catch(handleSupervisedFailure);
  };

  const waitForInitialLiveness = async (): Promise<TerminalHostLiveness> => {
    const startedAtMs = nowMs();
    let lastLiveness: TerminalHostLiveness | undefined;
    let lastError: unknown;
    while (!disposed) {
      try {
        const liveness = await opts.host.evaluateLiveness();
        if (liveness.paneAlive || initialLivenessTimeoutMs <= 0) {
          return liveness;
        }
        lastLiveness = liveness;
        lastError = undefined;
      } catch (error) {
        if (initialLivenessTimeoutMs <= 0) throw error;
        lastError = error;
      }

      const remainingMs = initialLivenessTimeoutMs - (nowMs() - startedAtMs);
      if (remainingMs <= 0) {
        if (lastLiveness) return lastLiveness;
        throw lastError;
      }
      await wait(Math.min(initialLivenessPollMs, remainingMs));
    }

    return lastLiveness ?? { paneAlive: true, observedAt: nowMs() };
  };

  return {
    async run() {
      if (disposed) return;
      if (running) return;
      running = true;
      let liveness: TerminalHostLiveness;
      try {
        liveness = initialLivenessTimeoutMs > 0
          ? await waitForInitialLiveness()
          : await opts.host.evaluateLiveness();
      } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
      }
      if (disposed) return;
      if (!liveness.paneAlive && liveness.probeInconclusive !== true) {
        await dispose().catch(() => undefined);
        throw new ClaudeUnifiedTerminalHostDeadError(liveness);
      }
      try {
        // Start host/readiness safety observation before awaiting provider-observer installation.
        // Transcript setup can legitimately wait on provider-owned state; it must not make the
        // bounded terminal readiness/dialog path unreachable while the provider is stuck before
        // SessionStart. Pending input remains closed until the provider observers finish installing.
        startSupervised(opts.transcriptBridge);
        if (opts.observerBridge) {
          await Promise.resolve(opts.observerBridge.start({ abortSignal: abortController.signal }));
        }
        if (disposed) return;
        startSupervised(opts.pendingQueuePump);
      } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
      }
    },
    dispose,
  };
}
