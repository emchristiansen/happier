import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedController } from './createClaudeUnifiedController';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';

const createIdleSnapshot = () => ({
  pendingQueuePumpStateVersion: 0,
  queuedCount: 0,
  pendingInjectionCount: 0,
  terminalCustodyCount: 0,
  providerAcceptancePendingCount: 0,
  disposed: false,
  turnState: 'idle' as const,
  permissionBlocked: false,
  userTyping: false,
  lastDeferredReason: null,
  lastFailureReason: null,
  currentHeadBlocker: null,
  headInputState: null,
});

async function waitForPendingQueuePumpStateChangeUntilAbort(options: Readonly<{
  abortSignal: AbortSignal;
}>): Promise<boolean> {
  if (options.abortSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    options.abortSignal.addEventListener('abort', () => resolve(false), { once: true });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitOneTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createClaudeUnifiedController', () => {
  it('fails closed when the terminal host is not alive', async () => {
    const disposeHost = vi.fn().mockResolvedValue(undefined);
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
      observedAt: 1,
    };
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue(liveness),
        preserve: disposeHost,
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });
    expect(disposeHost).toHaveBeenCalledTimes(1);
  });

  it('preserves the typed host-dead error when cleanup after a dead host fails', async () => {
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 1,
      observedAt: 1,
    };
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue(liveness),
        preserve: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });
  });

  it('retries transient startup liveness failures before starting supervised bridges', async () => {
    const initialLiveness = {
      paneAlive: false,
      paneDead: true,
      observedAt: 1,
    };
    const recoveredLiveness = {
      paneAlive: true,
      observedAt: 2,
    };
    const evaluateLiveness = vi.fn()
      .mockResolvedValueOnce(initialLiveness)
      .mockResolvedValueOnce(recoveredLiveness);
    const disposeHost = vi.fn();
    const pendingStart = vi.fn();
    const transcriptStart = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness,
        preserve: disposeHost,
      },
      pendingQueuePump: {
        start: pendingStart,
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: transcriptStart,
        dispose: vi.fn(),
      },
      initialLivenessTimeoutMs: 25,
      initialLivenessPollMs: 1,
    });

    await expect(controller.run()).resolves.toBeUndefined();

    expect(evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(transcriptStart).toHaveBeenCalledTimes(1);
    expect(pendingStart).toHaveBeenCalledTimes(1);
    expect(disposeHost).not.toHaveBeenCalled();
  });

  it('degrades through an inconclusive initial probe without declaring or disposing a live host', async () => {
    const disposeHost = vi.fn();
    const pendingStart = vi.fn();
    const transcriptStart = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({
          paneAlive: false,
          probeInconclusive: true,
          observedAt: 1,
        }),
        preserve: disposeHost,
      },
      pendingQueuePump: {
        start: pendingStart,
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: transcriptStart,
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).resolves.toBeUndefined();

    expect(transcriptStart).toHaveBeenCalledTimes(1);
    expect(pendingStart).toHaveBeenCalledTimes(1);
    expect(disposeHost).not.toHaveBeenCalled();
  });

  it('aborts producers before releasing terminal host ownership without destroying it', async () => {
    const disposeOrder: string[] = [];
    let producerAbortObservedDuringHostRelease = false;
    const orderedHostRelease = vi.fn(async () => {
      disposeOrder.push('host');
      await waitOneTurn();
      producerAbortObservedDuringHostRelease = disposeOrder.includes('pump');
    });
    const pumpDispose = vi.fn(async () => {
      disposeOrder.push('pump');
    });
    const transcriptDispose = vi.fn(async () => {
      disposeOrder.push('transcript');
    });
    const arbiterDispose = vi.fn(async () => {
      disposeOrder.push('arbiter');
    });
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: orderedHostRelease,
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: pumpDispose,
      },
      arbiter: {
        dispose: arbiterDispose,
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: transcriptDispose,
      },
    });

    await controller.run();
    await controller.dispose();
    await controller.dispose();

    expect(pumpDispose).toHaveBeenCalledTimes(1);
    expect(transcriptDispose).toHaveBeenCalledTimes(1);
    expect(arbiterDispose).toHaveBeenCalledTimes(1);
    expect(orderedHostRelease).toHaveBeenCalledTimes(1);
    expect(producerAbortObservedDuringHostRelease).toBe(true);
    expect(disposeOrder).toEqual(['pump', 'transcript', 'arbiter', 'host']);
  });

  it('keeps the pending queue pump closed until the provider observer installs', async () => {
    const observerStartup = createDeferred<void>();
    const order: string[] = [];
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => {
          order.push('pump-start');
        }),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      observerBridge: {
        start: vi.fn(() => {
          order.push('observer-start');
          return observerStartup.promise;
        }),
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(() => {
          order.push('safety-observer-start');
        }),
        dispose: vi.fn(),
      },
    });

    const runPromise = controller.run();
    await Promise.resolve();

    expect(order).toEqual(['safety-observer-start', 'observer-start']);

    observerStartup.resolve();
    await runPromise;
    expect(order).toEqual(['safety-observer-start', 'observer-start', 'pump-start']);
  });

  it('does not start the pending queue pump when provider observer installation rejects', async () => {
    const observerError = new Error('provider observer installation failed');
    const pendingStart = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn(),
      },
      pendingQueuePump: {
        start: pendingStart,
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      observerBridge: {
        start: vi.fn().mockRejectedValue(observerError),
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).rejects.toBe(observerError);
    expect(pendingStart).not.toHaveBeenCalled();
  });

  it('starts the pending queue pump without waiting for its running task', async () => {
    const pumpRun = createDeferred<void>();
    const order: string[] = [];
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => {
          order.push('pump-start');
          return pumpRun.promise;
        }),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
    });

    const runPromise = controller.run();
    let runResolved = false;
    void runPromise.then(() => {
      runResolved = true;
    });
    await waitOneTurn();

    expect(runResolved).toBe(true);
    expect(order).toEqual(['pump-start']);

    pumpRun.resolve();
    await runPromise;
  });

  it('keeps a healthy host alive when the pending pump parks after repeated input waiting failures', async () => {
    vi.useFakeTimers();
    const pumpError = new Error('pending queue materialization failed');
    const onFatalError = vi.fn();
    const disposeHost = vi.fn();
    const pendingQueuePump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn()
          .mockRejectedValueOnce(pumpError)
          .mockRejectedValueOnce(pumpError)
          .mockRejectedValueOnce(pumpError)
          .mockResolvedValueOnce(null),
      },
      arbiter: {
        enqueueUiMessage: vi.fn(),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });
    try {
      const controller = createClaudeUnifiedController({
        host: {
          evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
          preserve: disposeHost,
        },
        pendingQueuePump,
        arbiter: {
          dispose: vi.fn(),
        },
        onFatalError,
      });

      await expect(controller.run()).resolves.toBeUndefined();
      await Promise.resolve();
      expect(onFatalError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3);

      expect(onFatalError).not.toHaveBeenCalled();
      expect(disposeHost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes an unexpected pending queue arbiter crash through the fatal path', async () => {
    const drainError = new Error('pending queue drain failed');
    const onFatalError = vi.fn();
    const pendingQueuePump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockResolvedValue({
          message: 'from queue',
          mode: undefined,
          isolate: false,
          hash: 'same-mode',
        }),
      },
      arbiter: {
        enqueueUiMessage: vi.fn().mockResolvedValue(undefined),
        drainWhenSafe: vi.fn().mockRejectedValue(drainError),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn(),
      },
      pendingQueuePump,
      arbiter: {
        dispose: vi.fn(),
      },
      onFatalError,
    });

    await expect(controller.run()).resolves.toBeUndefined();
    await waitOneTurn();

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError).toHaveBeenCalledWith(drainError);
  });

  it('ignores pending queue pump failures after disposal', async () => {
    const pumpFailure = createDeferred<void>();
    const onFatalError = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => pumpFailure.promise),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      onFatalError,
    });

    const runPromise = controller.run();
    void runPromise.catch(() => undefined);
    let runResolved = false;
    void runPromise.then(() => {
      runResolved = true;
    });
    await waitOneTurn();

    expect(runResolved).toBe(true);
    await controller.dispose();
    pumpFailure.reject(new Error('late pump failure'));
    await Promise.resolve();
    await runPromise;

    expect(onFatalError).not.toHaveBeenCalled();
  });

  it('continues disposing bridges and never propagates host disposal failure', async () => {
    const hostError = new Error('host cleanup failed');
    const pumpDispose = vi.fn().mockResolvedValue(undefined);
    const transcriptDispose = vi.fn().mockResolvedValue(undefined);
    const arbiterDispose = vi.fn().mockResolvedValue(undefined);
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        preserve: vi.fn().mockRejectedValue(hostError),
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: pumpDispose,
      },
      arbiter: {
        dispose: arbiterDispose,
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: transcriptDispose,
      },
    });

    await controller.run();
    await expect(controller.dispose()).resolves.toBeUndefined();

    expect(pumpDispose).toHaveBeenCalledTimes(1);
    expect(transcriptDispose).toHaveBeenCalledTimes(1);
    expect(arbiterDispose).toHaveBeenCalledTimes(1);
  });
});
