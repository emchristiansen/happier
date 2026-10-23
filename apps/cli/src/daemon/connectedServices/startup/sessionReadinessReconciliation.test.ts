import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceSessionAuthSwitchLockRegistry } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeTargetRegistration,
} from '../runtimeRegistry/registry';
import {
  CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS,
  CONNECTED_SERVICE_SESSION_READINESS_WAIT_MS,
  createConnectedServiceSessionReadinessReconciliation,
} from './sessionReadinessReconciliation';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function registerRunner(registry: ConnectedServiceRuntimeRegistry): ConnectedServiceRuntimeTargetRegistration {
  const target = registry.registerTarget({
    pid: 4242,
    sessionId: 'session-starting',
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
    },
  });
  return { key: { kind: 'session', pid: target.pid }, target };
}

/** Observes whether readiness has answered without awaiting it. */
function observe(readiness: Promise<void>) {
  const state: { answer: 'waiting' | 'ready' | 'failed'; error: unknown } = { answer: 'waiting', error: null };
  readiness.then(
    () => { state.answer = 'ready'; },
    (error: unknown) => { state.answer = 'failed'; state.error = error; },
  );
  return state;
}

describe('createConnectedServiceSessionReadinessReconciliation', () => {
  const waitMs = CONNECTED_SERVICE_SESSION_READINESS_WAIT_MS;
  const { initialMs } = CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS;
  let registry: ConnectedServiceRuntimeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ConnectedServiceRuntimeRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createReadiness(reconcile: (registration: ConnectedServiceRuntimeTargetRegistration) => Promise<void>) {
    return createConnectedServiceSessionReadinessReconciliation({
      reconcile,
      isCurrent: (registration) => registry.isCurrentTargetRegistration(registration),
      isShuttingDown: () => false,
    });
  }

  it('answers readiness after the wait while the reconciliation is still running, without restarting it', async () => {
    const hung = deferred();
    const reconcile = vi.fn(async () => await hung.promise);
    const readiness = observe(createReadiness(reconcile)(registerRunner(registry)));

    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(readiness.answer).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);

    expect(readiness.answer).toBe('ready');
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when the reconciliation fails within the wait, leaving the retry to the runner', async () => {
    const failure = new Error('account profile unavailable');
    const reconcile = vi.fn(async () => { throw failure; });
    const readiness = observe(createReadiness(reconcile)(registerRunner(registry)));

    await vi.advanceTimersByTimeAsync(0);
    expect(readiness).toEqual({ answer: 'failed', error: failure });
    await vi.advanceTimersByTimeAsync(10 * initialMs);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('retries a live application that fails after readiness answered until it succeeds', async () => {
    // D43-003: the hot application takes the free session lock, outlasts the readiness wait, then
    // fails transiently. The failed application must run again without waiting for an unrelated event.
    const locks = new ConnectedServiceSessionAuthSwitchLockRegistry();
    const firstApplication = deferred();
    const applied: string[] = [];
    let applications = 0;
    const reconcile = vi.fn(async () => {
      await locks.runExclusive('session-starting', async () => {
        applications += 1;
        if (applications === 1) await firstApplication.promise;
        applied.push(`application-${applications}`);
      });
    });
    const readiness = observe(createReadiness(reconcile)(registerRunner(registry)));

    await vi.advanceTimersByTimeAsync(waitMs);
    expect(readiness.answer).toBe('ready');
    expect(locks.isHeldByAnotherOwner('session-starting')).toBe(true);

    firstApplication.reject(new Error('hot application failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(locks.isHeldByAnotherOwner('session-starting')).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(initialMs);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['application-2']);

    await vi.advanceTimersByTimeAsync(CONNECTED_SERVICE_SESSION_READINESS_RETRY_DELAY_MS.maxMs * 2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('backs off between retries that keep failing', async () => {
    const hung = deferred();
    let calls = 0;
    const reconcile = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await hung.promise;
      throw new Error(`reconciliation ${calls} failed`);
    });
    observe(createReadiness(reconcile)(registerRunner(registry)));
    await vi.advanceTimersByTimeAsync(waitMs);
    hung.reject(new Error('reconciliation 1 failed'));

    await vi.advanceTimersByTimeAsync(initialMs);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * initialMs - 1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('admits no new retry once daemon shutdown has begun', async () => {
    // F46-002: a retry scheduled before shutdown must not start a fresh reconciliation (account
    // fetch, rematerialization, hot application) while shutdown drains, though the runner's
    // registration is still current.
    const hung = deferred();
    const reconcile = vi.fn(async () => await hung.promise);
    let shuttingDown = false;
    const readiness = createConnectedServiceSessionReadinessReconciliation({
      reconcile,
      isCurrent: (registration) => registry.isCurrentTargetRegistration(registration),
      isShuttingDown: () => shuttingDown,
    });
    const registration = registerRunner(registry);
    observe(readiness(registration));
    await vi.advanceTimersByTimeAsync(waitMs);
    hung.reject(new Error('hot application failed'));
    await vi.advanceTimersByTimeAsync(1_000);

    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(10 * initialMs);

    expect(registry.isCurrentTargetRegistration(registration)).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('schedules no retry for a failure that arrives after daemon shutdown has begun', async () => {
    const hung = deferred();
    const reconcile = vi.fn(async () => await hung.promise);
    let shuttingDown = false;
    const readiness = createConnectedServiceSessionReadinessReconciliation({
      reconcile,
      isCurrent: (registration) => registry.isCurrentTargetRegistration(registration),
      isShuttingDown: () => shuttingDown,
    });
    observe(readiness(registerRunner(registry)));
    await vi.advanceTimersByTimeAsync(waitMs);

    shuttingDown = true;
    hung.reject(new Error('hot application failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * initialMs);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the runner registration is replaced', async () => {
    const hung = deferred();
    const reconcile = vi.fn(async () => await hung.promise);
    const registration = registerRunner(registry);
    observe(createReadiness(reconcile)(registration));
    await vi.advanceTimersByTimeAsync(waitMs);

    registry.unregisterSessionTargetByPid(registration.target.pid);
    hung.reject(new Error('hot application failed'));
    await vi.advanceTimersByTimeAsync(10 * initialMs);

    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
