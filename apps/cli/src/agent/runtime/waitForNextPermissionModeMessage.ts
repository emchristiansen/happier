import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
  SessionProviderInputConsumerOptions,
  SessionProviderInputConsumerSession,
} from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { MessageBatch, SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  inputConsumer?: SessionProviderInputConsumer<Mode, Message>;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<Mode, Message> | null> {
  const session: SessionProviderInputConsumerSession = {
    materializeNextPendingMessageSafely: (materializeOpts) =>
      opts.session.materializeNextPendingMessageSafely(materializeOpts),
    shouldAttemptPendingMaterialization: () => opts.session.shouldAttemptPendingMaterialization?.() ?? true,
    reconcilePendingQueueState: async (reconcileOpts) => {
      await opts.session.reconcilePendingQueueState?.(reconcileOpts);
    },
    waitForPendingEligibilityUpdate: (signal) => opts.session.waitForPendingEligibilityUpdate(signal),
    ...(typeof opts.session.waitForMetadataUpdate === 'function'
      ? { waitForMetadataUpdate: (signal?: AbortSignal) => opts.session.waitForMetadataUpdate(signal) }
      : {}),
  };

  const consumerOptions: SessionProviderInputConsumerOptions<Mode, Message> = {
    messageQueue: opts.messageQueue,
    session,
    reconcileWhenEmpty: 'skip',
  };
  if (opts.onMetadataUpdate !== undefined) {
    consumerOptions.onMetadataUpdate = opts.onMetadataUpdate;
  }

  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer(consumerOptions);

  return await inputConsumer.waitForNextInput({
    abortSignal: opts.abortSignal,
    onMetadataUpdate: opts.onMetadataUpdate,
  });
}
