import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DurableBackoffRecoveryScheduler } from './DurableBackoffRecoveryScheduler';
import { createRecoveryIntentFileStore } from './recoveryIntentFileStore';

type TestIntent = Readonly<{
  status: 'waiting' | 'checking' | 'cancelled' | 'exhausted';
  nextRetryAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  terminalAtMs?: number | null;
}>;

function createIntent(): TestIntent {
  return {
    status: 'waiting',
    nextRetryAtMs: 1_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastError: null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('DurableBackoffRecoveryScheduler', () => {
  it.each(['memory', 'file'] as const)('observes atomically without a claim or retry charge (%s)', async (storage) => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-atomic-observation-'));
    const store = storage === 'file' ? createRecoveryIntentFileStore<TestIntent>(join(directory, 'intents.json')) : undefined;
    const recover = vi.fn(async () => ({ status: 'wait' as const }));
    const markChecking = vi.fn((intent: TestIntent, attemptCount: number) => ({ ...intent, status: 'checking' as const, attemptCount }));
    const onDelayed = vi.fn();
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000, store, normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status, getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount, getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking, markWaiting: (intent, input) => ({ ...intent, status: 'waiting', ...input }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled' }),
      markExhausted: (intent) => ({ ...intent, status: 'exhausted' }), recover, onDelayed,
      observeBeforeEffectClaim: (intent) => ({ intent: { ...intent, nextRetryAtMs: 9_000 }, retryAtMs: 9_000, reason: 'awaiting_proof' }),
    });
    try {
      await scheduler.upsertByKey({ sessionId: 'session', recoveryKey: 'key', intent: createIntent() });
      await scheduler.wakeByKey({ recoveryKey: 'key', reason: 'manual' });
      expect(scheduler.readByKeyPassive('key')).toMatchObject({ status: 'waiting', attemptCount: 0, nextRetryAtMs: 9_000 });
      expect(recover).not.toHaveBeenCalled(); expect(markChecking).not.toHaveBeenCalled();
      expect(onDelayed).toHaveBeenCalledWith(expect.objectContaining({ retryAtMs: 9_000, reason: 'awaiting_proof' }));
      if (store) {
        expect(await store.transact('key', (current) => ({ ...current, result: current.effectClaimToken }))).toBeNull();
      }
    } finally {
      scheduler.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets only one of two durable scheduler controllers execute recovery for a key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-claim-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryOutcome = createDeferred<{ status: 'wait'; lastError: string }>();
    let recoverCalls = 0;

    const createScheduler = () => new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      store: createRecoveryIntentFileStore<TestIntent>(filePath),
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextRetryAtMs: input.nextRetryAtMs,
        lastError: input.lastError,
      }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: input.lastError,
      }),
      recover: async () => {
        recoverCalls += 1;
        return await recoveryOutcome.promise;
      },
    });

    try {
      const first = createScheduler();
      const second = createScheduler();
      await first.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });

      const firstWake = first.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      while (recoverCalls < 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const secondWake = second.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await expect(Promise.race([
        secondWake,
        new Promise((_, reject) => setTimeout(() => reject(new Error('second controller did not join durable claim')), 500)),
      ])).resolves.toEqual({ status: 'checking' });

      recoveryOutcome.resolve({ status: 'wait', lastError: 'still blocked' });
      await Promise.all([firstWake, secondWake]);

      expect(recoverCalls).toBe(1);
    } finally {
      recoveryOutcome.resolve({ status: 'wait', lastError: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let a sibling dead-letter the final allowed attempt while its owner is still recovering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-final-claim-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<{ status: 'success' }>();
    const onExhausted = vi.fn();
    const createScheduler = () => new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore<TestIntent>(filePath),
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({ ...intent, status: 'waiting', nextRetryAtMs: input.nextRetryAtMs }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
      markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
      onExhausted,
      recover: async () => {
        recoveryStarted.resolve();
        return await recoveryOutcome.promise;
      },
    });
    try {
      const owner = createScheduler();
      const sibling = createScheduler();
      await owner.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'recovery-1',
        intent: { ...createIntent(), maxAttempts: 1 },
      });

      const ownerWake = owner.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await recoveryStarted.promise;
      const siblingResult = await sibling.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      const exhaustedCallsWhileOwned = onExhausted.mock.calls.length;
      recoveryOutcome.resolve({ status: 'success' });
      const ownerResult = await ownerWake;

      expect(siblingResult).toEqual({ status: 'checking' });
      expect(exhaustedCallsWhileOwned).toBe(0);
      expect(ownerResult).toEqual({ status: 'succeeded' });
      expect(createRecoveryIntentFileStore<TestIntent>(filePath).read('recovery-1')).toMatchObject({ status: 'cancelled' });
    } finally {
      recoveryOutcome.resolve({ status: 'success' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let a sibling gate mutate or project delay while another controller owns the effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-gated-claim-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<{ status: 'wait'; lastError: string }>();
    const onDelayed = vi.fn();
    const createScheduler = (gate?: () => { status: 'delayed'; retryAtMs: number; reason: string }) => (
      new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        store: createRecoveryIntentFileStore<TestIntent>(filePath),
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({ ...intent, status: 'waiting', nextRetryAtMs: input.nextRetryAtMs }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
        markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
        ...(gate ? { gate } : {}),
        onDelayed,
        recover: async () => {
          recoveryStarted.resolve();
          return await recoveryOutcome.promise;
        },
      })
    );
    try {
      const owner = createScheduler();
      const sibling = createScheduler(() => ({
        status: 'delayed',
        retryAtMs: 5_000,
        reason: 'local_gate',
      }));
      await owner.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });

      const ownerWake = owner.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await recoveryStarted.promise;
      const siblingResult = await sibling.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      const delayedCallsWhileOwned = onDelayed.mock.calls.length;
      const persistedStatusWhileOwned = createRecoveryIntentFileStore<TestIntent>(filePath).read('recovery-1');
      recoveryOutcome.resolve({ status: 'wait', lastError: 'still blocked' });
      await ownerWake;

      expect(siblingResult).toEqual({ status: 'checking' });
      expect(delayedCallsWhileOwned).toBe(0);
      expect(persistedStatusWhileOwned).toMatchObject({ status: 'checking' });
    } finally {
      recoveryOutcome.resolve({ status: 'wait', lastError: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let a stale recovery settlement regress another controller cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-fence-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<{ status: 'wait'; lastError: string }>();

    const createScheduler = () => new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      store: createRecoveryIntentFileStore<TestIntent>(filePath),
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextRetryAtMs: input.nextRetryAtMs,
        lastError: input.lastError,
      }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: input.lastError,
      }),
      recover: async () => {
        recoveryStarted.resolve();
        return await recoveryOutcome.promise;
      },
    });

    try {
      const recovering = createScheduler();
      const cancelling = createScheduler();
      await recovering.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });

      const wake = recovering.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await recoveryStarted.promise;
      await cancelling.cancelByKey('recovery-1');
      recoveryOutcome.resolve({ status: 'wait', lastError: 'late failure' });
      await wake;

      expect(createRecoveryIntentFileStore<TestIntent>(filePath).read('recovery-1')).toMatchObject({
        status: 'cancelled',
      });
    } finally {
      recoveryOutcome.resolve({ status: 'wait', lastError: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fences stale effects when another controller cancels every intent for the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-session-cancel-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<{ status: 'wait'; lastError: string }>();
    const createScheduler = () => new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore<TestIntent>(filePath),
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      getSessionId: () => 'session-1',
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({ ...intent, status: 'waiting', nextRetryAtMs: input.nextRetryAtMs }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
      markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
      recover: async () => {
        recoveryStarted.resolve();
        return await recoveryOutcome.promise;
      },
    });
    try {
      const recovering = createScheduler();
      const cancelling = createScheduler();
      await recovering.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });
      const wake = recovering.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await recoveryStarted.promise;
      await cancelling.cancelForSession('session-1');
      recoveryOutcome.resolve({ status: 'wait', lastError: 'late wait' });
      await wake;

      expect(createRecoveryIntentFileStore<TestIntent>(filePath).read('recovery-1')).toMatchObject({ status: 'cancelled' });
    } finally {
      recoveryOutcome.resolve({ status: 'wait', lastError: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hydrates durable recovery state passively without arming execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-passive-'));
    const filePath = join(dir, 'recovery.json');
    const recover = vi.fn(async () => ({ status: 'success' as const }));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const store = createRecoveryIntentFileStore<TestIntent>(filePath);
      await store.write('recovery-1', { ...createIntent(), nextRetryAtMs: 0 });
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        store,
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({ ...intent, status: 'waiting', nextRetryAtMs: input.nextRetryAtMs }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
        markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
        recover,
      });

      setTimeoutSpy.mockClear();
      expect(scheduler.hydratePassive()).toHaveLength(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(scheduler.readByKeyPassive('recovery-1')).toMatchObject({ status: 'waiting' });
      scheduler.dispose();
    } finally {
      setTimeoutSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains a crashed controller claim until a confirmed-owner-loss action rearms it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-crash-'));
    const filePath = join(dir, 'recovery.json');
    const firstRecoveryStarted = createDeferred<void>();
    const neverSettles = new Promise<{ status: 'wait'; lastError: string }>(() => {});
    let replacementRecoverCalls = 0;
    const createScheduler = (recover: () => Promise<{ status: 'wait'; lastError: string }>) => (
      new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: createRecoveryIntentFileStore<TestIntent>(filePath),
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
        markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
        recover,
      })
    );

    try {
      const crashed = createScheduler(async () => {
        firstRecoveryStarted.resolve();
        return await neverSettles;
      });
      await crashed.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });
      void crashed.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await firstRecoveryStarted.promise;
      crashed.dispose();

      const replacement = createScheduler(async () => {
        replacementRecoverCalls += 1;
        return { status: 'wait', lastError: 'still blocked' };
      });
      expect(replacement.hydratePassive()).toHaveLength(1);
      await expect(replacement.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' }))
        .resolves.toEqual({ status: 'checking' });
      expect(replacementRecoverCalls).toBe(0);

      await replacement.rearmAfterConfirmedEffectOwnerLossByKey({
        recoveryKey: 'recovery-1',
        authorization: 'fresh_user_action_after_owner_loss',
      });
      await replacement.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      expect(replacementRecoverCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fences a stale effect after another controller records an external terminal settlement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-durable-recovery-terminal-'));
    const filePath = join(dir, 'recovery.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<{ status: 'wait'; lastError: string }>();
    const onTerminal = vi.fn();
    const createScheduler = () => new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore<TestIntent>(filePath),
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({ ...intent, status: 'waiting', nextRetryAtMs: input.nextRetryAtMs }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null }),
      markExhausted: (intent, input) => ({ ...intent, status: 'exhausted', nextRetryAtMs: null, lastError: input.lastError }),
      onTerminal,
      recover: async () => {
        recoveryStarted.resolve();
        return await recoveryOutcome.promise;
      },
    });
    try {
      const recovering = createScheduler();
      const settling = createScheduler();
      await recovering.upsertByKey({ sessionId: 'session-1', recoveryKey: 'recovery-1', intent: createIntent() });
      const wake = recovering.wakeByKey({ recoveryKey: 'recovery-1', reason: 'manual', sessionId: 'session-1' });
      await recoveryStarted.promise;

      await settling.upsertSettledByKey({
        sessionId: 'session-1',
        recoveryKey: 'recovery-1',
        intent: { ...createIntent(), status: 'cancelled', nextRetryAtMs: null },
      });
      recoveryOutcome.resolve({ status: 'wait', lastError: 'late wait' });

      await expect(wake).resolves.toEqual({ status: 'inactive' });
      expect(createRecoveryIntentFileStore<TestIntent>(filePath).read('recovery-1')).toMatchObject({ status: 'cancelled' });
    } finally {
      recoveryOutcome.resolve({ status: 'wait', lastError: 'cleanup' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores and reads separate recovery intents with explicit recovery keys in one session', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsert({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: { ...createIntent(), lastError: 'codex' },
      });
      await scheduler.upsert({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:anthropic:backup:none',
        intent: { ...createIntent(), lastError: 'anthropic' },
      });

      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toMatchObject({
        lastError: 'codex',
      });
      expect(scheduler.readByKey('runtime-auth:v1:session-1:anthropic:backup:none')).toMatchObject({
        lastError: 'anthropic',
      });
      expect(scheduler.readForSession('session-1').map((intent) => intent.lastError).sort()).toEqual([
        'anthropic',
        'codex',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges an explicit recovery-key upsert with the normalized previous intent', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: {
          ...createIntent(),
          attemptCount: 2,
          nextRetryAtMs: 900,
          lastError: 'previous timeout',
        },
      });

      const merged = await scheduler.upsertMergedByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: {
          ...createIntent(),
          attemptCount: 0,
          nextRetryAtMs: 1_500,
          lastError: 'latest timeout',
        },
        merge: (previous, next) => ({
          ...next,
          attemptCount: previous?.attemptCount ?? next.attemptCount,
          nextRetryAtMs: Math.min(previous?.nextRetryAtMs ?? next.nextRetryAtMs ?? Number.POSITIVE_INFINITY, next.nextRetryAtMs ?? Number.POSITIVE_INFINITY),
          lastError: next.lastError,
        }),
      });

      expect(merged).toMatchObject({
        attemptCount: 2,
        nextRetryAtMs: 900,
        lastError: 'latest timeout',
      });
      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toEqual(merged);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an explicit recovery key from memory and durable storage without marking it cancelled', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const removed: string[] = [];
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          write: (key, intent) => {
            written.set(key, intent);
          },
          remove: (key) => {
            written.delete(key);
            removed.push(key);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: createIntent(),
      });

      await expect(scheduler.clearByKey('runtime-auth:v1:session-1:codex:primary:none'))
        .resolves.toMatchObject({ status: 'waiting' });

      expect(removed).toEqual(['runtime-auth:v1:session-1:codex:primary:none']);
      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes stale terminal recovery intents before durable writes', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>([
        ['old-cancelled', { ...createIntent(), status: 'cancelled', nextRetryAtMs: null, terminalAtMs: 1_000 }],
        ['fresh-exhausted', { ...createIntent(), status: 'exhausted', nextRetryAtMs: null, terminalAtMs: 9_500 }],
        ['active-waiting', { ...createIntent(), nextRetryAtMs: 12_000 }],
      ]);
      const pruned: string[] = [];
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 10_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        terminalRecordRetentionMs: 5_000,
        getTerminalPruneReferenceMs: (intent) => intent.terminalAtMs ?? null,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
          prune: (predicate) => {
            const removed: string[] = [];
            for (const [recoveryKey, value] of written.entries()) {
              if (!predicate({ recoveryKey, value })) continue;
              written.delete(recoveryKey);
              removed.push(recoveryKey);
            }
            pruned.push(...removed);
            return removed;
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsert({ sessionId: 'new-session', intent: createIntent() });

      expect(pruned).toEqual(['old-cancelled']);
      expect(written.has('old-cancelled')).toBe(false);
      expect(written.has('fresh-exhausted')).toBe(true);
      expect(written.has('active-waiting')).toBe(true);
      expect(written.has('new-session')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes thrown recovery errors before persisting retry state', async () => {
    vi.useFakeTimers();
    try {
      const rawAccessToken = 'scheduler-access-token-secret';
      const rawPath = '/Users/alice/.codex/auth.json';
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (sessionId) => written.get(sessionId) ?? null,
          write: (sessionId, intent) => {
            written.set(sessionId, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => {
          throw new Error(`probe failed accessToken=${rawAccessToken} path=${rawPath}`);
        },
      });

      await scheduler.upsert({ sessionId: 'session-1', intent: createIntent() });
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

      const intent = scheduler.read('session-1');
      expect(intent?.lastError).not.toContain(rawAccessToken);
      expect(intent?.lastError).not.toContain(rawPath);
      expect(intent?.lastError).toContain('[REDACTED]');
      expect(intent?.lastError).toContain('[REDACTED_LOCAL_PATH]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cancellation durable when recover resolves after cancel', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const recoverStarted = createDeferred<void>();
      const recoverOutcome = createDeferred<{
        status: 'wait';
        lastError: string;
      }>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (sessionId) => written.get(sessionId) ?? null,
          write: (sessionId, intent) => {
            written.set(sessionId, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => {
          recoverStarted.resolve();
          return await recoverOutcome.promise;
        },
      });

      await scheduler.upsert({ sessionId: 'session-1', intent: createIntent() });

      const wakePromise = scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
      await recoverStarted.promise;

      await scheduler.cancel({ sessionId: 'session-1' });
      expect(scheduler.read('session-1')?.status).toBe('cancelled');

      recoverOutcome.resolve({ status: 'wait', lastError: 'still blocked' });

      await expect(wakePromise).resolves.toEqual({ status: 'inactive' });
      expect(scheduler.read('session-1')?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('chunks long timers and rearms when a timer callback fires before the retry time', async () => {
    const maxSafeTimerDelayMs = 2_147_483_647;
    const capturedTimers: Array<Readonly<{ delayMs: number; fire: () => void }>> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      capturedTimers.push({
        delayMs: Number(delay ?? 0),
        fire: callback,
      });
      // Boundary fake for the timer handle; the scheduler only calls optional unref().
      return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    try {
      let nowMs = 1_000;
      const nextRetryAtMs = nowMs + maxSafeTimerDelayMs + 5_000;
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => nowMs,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null, lastError: null }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover,
      });

      await scheduler.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'k1',
        intent: {
          ...createIntent(),
          nextRetryAtMs,
        },
      });

      expect(capturedTimers[0]?.delayMs).toBe(maxSafeTimerDelayMs);

      nowMs += maxSafeTimerDelayMs;
      capturedTimers[0]?.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(recover).not.toHaveBeenCalled();
      const rearmedTimer = capturedTimers.at(-1);
      expect(rearmedTimer?.delayMs).toBe(5_000);

      nowMs = nextRetryAtMs;
      rearmedTimer?.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(recover).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('dispose() stops armed timers from firing recover and leaves the intent waiting on disk', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => Date.now(),
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
          remove: (key) => {
            written.delete(key);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null, lastError: null }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover,
      });

      // Arm a waiting intent whose timer is due in 100ms.
      await scheduler.upsert({
        sessionId: 'session-1',
        recoveryKey: 'k1',
        intent: { ...createIntent(), nextRetryAtMs: Date.now() + 100 },
      });

      // Dispose before the timer fires.
      scheduler.dispose();

      // Advancing past the fire time must NOT run recover.
      await vi.advanceTimersByTimeAsync(500);
      expect(recover).not.toHaveBeenCalled();

      // A manual wake after disposal is a no-op (does not run recover).
      await expect(scheduler.wakeByKey({ recoveryKey: 'k1', reason: 'manual' })).resolves.toEqual({ status: 'disposed' });
      expect(recover).not.toHaveBeenCalled();

      // The persisted intent remains `waiting` on disk for a future healthy daemon to re-drive.
      expect(written.get('k1')?.status).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() does not arm a new timer when an intent is re-read during teardown', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>([
        ['k1', { ...createIntent(), nextRetryAtMs: Date.now() + 100 }],
      ]);
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => Date.now(),
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null, lastError: null }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover,
      });

      scheduler.dispose();
      // readByKey internally calls schedule(); after disposal it must not arm a timer.
      expect(scheduler.readByKey('k1')?.status).toBe('waiting');
      await vi.advanceTimersByTimeAsync(500);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the durable record on a superseded outcome so the key can re-arm later', async () => {
    // A superseded recovery (the failure no longer applies — e.g. the group switched off the
    // failing profile) must REMOVE the record rather than terminalize it: a terminal
    // `cancelled` record would block re-arming the same recovery key on a genuine future
    // failure for the whole terminal-record retention window (RD-REC-13).
    const written = new Map<string, TestIntent>([
      ['k1', createIntent()],
    ]);
    const onSuperseded = vi.fn();
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
      nowMs: () => 2_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      store: {
        read: (key) => written.get(key) ?? null,
        readAll: () => [...written.entries()],
        write: (key, intent) => {
          written.set(key, intent);
        },
        remove: (key) => {
          written.delete(key);
        },
      },
      normalizeIntent: (value) => value as TestIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      markChecking: (intent, attemptCount) => ({ ...intent, status: 'checking', attemptCount }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextRetryAtMs: input.nextRetryAtMs,
        lastError: input.lastError,
      }),
      markCancelled: (intent) => ({ ...intent, status: 'cancelled', nextRetryAtMs: null, lastError: null }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: input.lastError,
      }),
      onSuperseded,
      recover: async () => ({ status: 'superseded', reason: 'failing_profile_inactive' }),
    });

    await expect(scheduler.wakeByKey({ recoveryKey: 'k1', reason: 'manual', sessionId: 'session-1' }))
      .resolves.toEqual({ status: 'superseded' });
    expect(written.has('k1')).toBe(false);
    expect(scheduler.readByKey('k1')).toBeNull();
    expect(onSuperseded).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      reason: 'failing_profile_inactive',
    }));
  });
});
