import { describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createDeferred } from '@/testkit/async/deferred';

import { waitForNextPermissionModeMessage } from './waitForNextPermissionModeMessage';
import { createSessionProviderInputConsumer } from './sessionInput/SessionProviderInputConsumer';

type QueueMode = { permissionMode: PermissionMode };
type PermissionModeSessionFixture = Pick<ApiSessionClient, 'popPendingMessage' | 'waitForPendingEligibilityUpdate'> & {
  materializeNextPendingMessageSafely: (opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
  }) => Promise<MaterializeNextPendingResult>;
};

function createQueue(): MessageQueue2<QueueMode> {
  return new MessageQueue2<QueueMode>(() => 'hash');
}

function asSessionClient(session: PermissionModeSessionFixture): ApiSessionClient {
  return session as unknown as ApiSessionClient;
}

describe('waitForNextPermissionModeMessage', () => {
  it('uses structured pending materialization without invoking boolean pop', async () => {
    const queue = createQueue();
    const popPendingMessage = vi.fn(async () => {
      queue.pushImmediate('from-legacy-pop', { permissionMode: 'default' });
      return true;
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queue.pushImmediate('from-safe-materialize', { permissionMode: 'default' });
      return {
        type: 'materialized',
        localId: 'local-safe',
        seq: 10,
        content: null,
      } satisfies MaterializeNextPendingResult;
    });

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForPendingEligibilityUpdate() {
        return false;
      },
    };

    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
    });

    expect(result?.message).toBe('from-safe-materialize');
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'skip',
    }));
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('waits after deferred safe materialization without falling back to legacy pop', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'deferred',
      reason: 'supervisor_offline',
    }) satisfies MaterializeNextPendingResult);

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const abortController = new AbortController();
    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: abortController.signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    abortController.abort();

    await expect(resultPromise).resolves.toBeNull();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'skip',
    }));
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('rejects when safe materialization reports terminal supervisor auth failure', async () => {
    const queue = createQueue();
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'deferred',
      reason: 'supervisor_auth_failed',
    }) satisfies MaterializeNextPendingResult);

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForPendingEligibilityUpdate() {
        return false;
      },
    };

    const result = await Promise.race([
      waitForNextPermissionModeMessage({
        messageQueue: queue,
        abortSignal: new AbortController().signal,
        session: asSessionClient(session),
      }).then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 10)),
    ]);

    expect(result).toMatch(/auth/i);
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it.each(['created', 'shared', 'shared-constructor'] as const)('wakes on metadata update and then processes a pending-queue item: %s consumer', async (consumerKind) => {
    const queue = createQueue();
    const metadataUpdate = createDeferred<boolean>();
    let pendingText: string | null = null;
    let popCount = 0;
    let metadataWakeConsumed = false;

    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        if (!pendingText) return { type: 'no_pending' };
        const text = pendingText;
        pendingText = null;
        queue.pushImmediate(text, { permissionMode: 'default' });
        return { type: 'materialized', localId: 'local-pending', seq: 1, content: null };
      },
      async popPendingMessage() {
        popCount += 1;
        return false;
      },
      async waitForPendingEligibilityUpdate(signal) {
        if (!metadataWakeConsumed) {
          metadataWakeConsumed = true;
          return await metadataUpdate.promise;
        }
        return await new Promise<boolean>((resolve) => {
          if (signal?.aborted) resolve(false);
          else signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const controller = new AbortController();
    // The session port supplies external pending rows/wakes; the shared consumer and wrapper stay real.
    const inputConsumer = consumerKind === 'shared'
      ? createSessionProviderInputConsumer({ messageQueue: queue, session, reconcileWhenEmpty: 'skip' })
      : consumerKind === 'shared-constructor'
        ? createSessionProviderInputConsumer({
          messageQueue: queue, session, reconcileWhenEmpty: 'skip',
          onMetadataUpdate: () => { pendingText = 'from-pending'; },
        })
        : undefined;
    let delivered: string | undefined;
    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: controller.signal,
      session: asSessionClient(session),
      inputConsumer,
      onMetadataUpdate: consumerKind === 'shared-constructor' ? undefined : () => {
        pendingText = 'from-pending';
      },
    }).then((result) => { delivered = result?.message; return result; });

    try {
      metadataUpdate.resolve(true);
      await expect.poll(() => delivered).toBe('from-pending');
      expect(popCount).toBe(0);
    } finally {
      controller.abort();
      await resultPromise;
    }
  });

  it.each([
    { onMetadataUpdate: undefined, expectedMode: 'plan' },
    { onMetadataUpdate: null, expectedMode: 'default' },
  ] as const)('preserves the shared construction callback unless the wait explicitly disables it: $expectedMode', async ({ onMetadataUpdate, expectedMode }) => {
    const queue = createQueue();
    let reconciledMode: PermissionMode = 'default';
    const session: PermissionModeSessionFixture = {
      popPendingMessage: async () => false,
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
      waitForPendingEligibilityUpdate: async () => false,
    };
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue, session,
      onMetadataUpdate: () => { reconciledMode = 'plan'; },
    });
    queue.pushImmediate('queued-before-wait', { permissionMode: 'default' });
    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue, session: asSessionClient(session), inputConsumer,
      abortSignal: new AbortController().signal, onMetadataUpdate,
    });
    expect(result?.message).toBe('queued-before-wait');
    expect(reconciledMode).toBe(expectedMode);
  });

  it('returns a queue message when one arrives while waiting', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        return { type: 'no_pending' };
      },
      async popPendingMessage() {
        return false;
      },
      async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    queue.pushImmediate('from-queue', { permissionMode: 'default' });

    const result = await resultPromise;
    expect(result?.message).toBe('from-queue');
  });

  it('reconciles metadata once when returning a queue message that arrives while waiting', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const onMetadataUpdate = vi.fn();
    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        return { type: 'no_pending' };
      },
      async popPendingMessage() {
        return false;
      },
      async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate,
    });

    await waitingForMetadata.promise;
    queue.pushImmediate('from-queue-after-model-change', { permissionMode: 'default' });

    const result = await resultPromise;
    expect(result?.message).toBe('from-queue-after-model-change');
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
  });

  it('reconciles metadata before returning an already queued message', async () => {
    const queue = createQueue();
    const onMetadataUpdate = vi.fn();
    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        return { type: 'no_pending' };
      },
      async popPendingMessage() {
        return false;
      },
      async waitForPendingEligibilityUpdate() {
        return false;
      },
    };
    queue.pushImmediate('already-queued-after-model-change', { permissionMode: 'default' });

    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate,
    });

    expect(result?.message).toBe('already-queued-after-model-change');
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns null when aborted while waiting for metadata updates', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    let popCount = 0;
    let waitCount = 0;

    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        return { type: 'no_pending' };
      },
      async popPendingMessage() {
        popCount += 1;
        return false;
      },
      async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal) {
        waitCount += 1;
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const abortController = new AbortController();
    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: abortController.signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    abortController.abort();

    await expect(resultPromise).resolves.toBeNull();
    expect(popCount).toBe(0);
    expect(waitCount).toBe(1);
  });

  it('continues processing when onMetadataUpdate throws', async () => {
    const queue = createQueue();
    let pendingText: string | null = null;
    let metadataWaitCalls = 0;

    const session: PermissionModeSessionFixture = {
      async materializeNextPendingMessageSafely() {
        if (!pendingText) return { type: 'no_pending' };
        const text = pendingText;
        pendingText = null;
        queue.pushImmediate(text, { permissionMode: 'default' });
        return { type: 'materialized', localId: 'local-callback', seq: 2, content: null };
      },
      async popPendingMessage() {
        return false;
      },
      async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal) {
        metadataWaitCalls += 1;
        if (metadataWaitCalls === 1) return true;
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate: () => {
        pendingText = 'after-callback-error';
        throw new Error('expected test callback failure');
      },
    });

    expect(metadataWaitCalls).toBeGreaterThanOrEqual(1);
    expect(result?.message).toBe('after-callback-error');
  });
});
