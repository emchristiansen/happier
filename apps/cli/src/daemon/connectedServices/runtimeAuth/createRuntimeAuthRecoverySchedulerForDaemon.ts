import { join } from 'node:path';

import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryIntent,
  type RuntimeAuthRecoverySchedulerDeps,
} from './RuntimeAuthRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { observeRuntimeAuthRecoveryIntentTransitions } from './runtimeAuthAttemptAccountJoin';

export function createRuntimeAuthRecoverySchedulerForDaemon(input: Readonly<{
  activeServerDir: string;
  /** Receives every committed attempt-level change for the attempt→applied-account journal. */
  onAttemptIntentCommitted?: (change: Readonly<{ before: RuntimeAuthRecoveryIntent | null; after: RuntimeAuthRecoveryIntent }>) => void;
}> & Omit<RuntimeAuthRecoverySchedulerDeps, 'durableStore'>): Readonly<{
  scheduler: RuntimeAuthRecoveryScheduler;
  hydratedIntents: ReadonlyArray<RuntimeAuthRecoveryIntent>;
}> {
  const { activeServerDir, onAttemptIntentCommitted, ...schedulerDeps } = input;
  const fileStore = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(
    activeServerDir,
    'connected-services',
    'runtime-auth-recovery.json',
  ));
  const scheduler = new RuntimeAuthRecoveryScheduler({
    ...schedulerDeps,
    durableStore: onAttemptIntentCommitted
      ? observeRuntimeAuthRecoveryIntentTransitions(fileStore, onAttemptIntentCommitted)
      : fileStore,
  });
  return {
    scheduler,
    hydratedIntents: scheduler.hydratePassive(),
  };
}
