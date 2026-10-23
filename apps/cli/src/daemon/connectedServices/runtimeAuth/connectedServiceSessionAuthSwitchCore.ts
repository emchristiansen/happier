import { AsyncLocalStorage } from 'node:async_hooks';

export type ConnectedServiceSessionAuthSwitchReason =
  | 'automatic_runtime_failure'
  | 'manual'
  | 'pre_turn_group_policy';

// Ordinary queued acquisition, not execution, is bounded: the executing owner keeps exclusion
// until it finishes. This is below the default 60s turn deferral and the 120s refresh scheduling
// lease. The one unbounded exception is `runExclusiveDeferredBackground`, for work nobody awaits.
const SESSION_AUTH_SWITCH_ACQUISITION_TIMEOUT_MS = 30_000;

type AcquisitionCancellationReason = 'timed_out' | 'session_stopped';

// How long a queued acquisition may wait. Both kinds stay cancellable by `clearSession`.
type AcquisitionBound =
  | Readonly<{ kind: 'bounded'; timeoutMs: number }>
  | Readonly<{ kind: 'until_acquired_or_stopped' }>;

export class ConnectedServiceSessionAuthSwitchAcquisitionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: AcquisitionCancellationReason,
  ) {
    super(`connected_service_session_auth_switch_acquisition_${reason}:${sessionId}`);
    this.name = 'ConnectedServiceSessionAuthSwitchAcquisitionError';
  }
}

type QueuedAcquisition = Readonly<{
  start(): void;
  cancel(reason: AcquisitionCancellationReason): void;
}>;

type SessionLock = {
  ownerId: symbol | null;
  queue: Set<QueuedAcquisition>;
};
type ActiveSessionLockOwner = Readonly<{
  registry: ConnectedServiceSessionAuthSwitchLockRegistry;
  sessionId: string;
  ownerId: symbol;
}>;

const activeSessionLockOwners = new AsyncLocalStorage<ReadonlyArray<ActiveSessionLockOwner>>();

export class ConnectedServiceSessionAuthSwitchLockRegistry {
  private readonly locksBySessionId = new Map<string, SessionLock>();

  /**
   * Runs `operation` while holding the session's lock. A queued acquisition fails with
   * `timed_out` after 30 seconds, or with `session_stopped` when `clearSession` cancels it.
   */
  runExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.acquire(sessionId, operation, {
      kind: 'bounded',
      timeoutMs: SESSION_AUTH_SWITCH_ACQUISITION_TIMEOUT_MS,
    });
  }

  /**
   * Like `runExclusive`, on the same lock and FIFO queue, with the same re-entry and caller
   * ancestry, except that a queued acquisition has no timeout: it runs after every transition
   * already holding or awaiting the lock, however long they take. Only `clearSession` (explicit
   * Stop or final child cleanup) cancels it while queued, with `session_stopped`; a cancelled
   * acquisition never runs later and is not requeued.
   *
   * Only work that nobody awaits may use this: the refreshed-credential distribution's deferred
   * application for a session whose lock another transition holds. An awaited caller uses
   * `runExclusive`, whose bound keeps it from waiting indefinitely. An owner that never finishes
   * keeps such an acquisition queued until the session is stopped.
   */
  runExclusiveDeferredBackground<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.acquire(sessionId, operation, { kind: 'until_acquired_or_stopped' });
  }

  private async acquire<T>(
    sessionId: string,
    operation: () => Promise<T>,
    bound: AcquisitionBound,
  ): Promise<T> {
    if (this.hasActiveOwner(sessionId)) {
      return await operation();
    }

    const parentOwners = activeSessionLockOwners.getStore() ?? [];
    const lock = this.locksBySessionId.get(sessionId) ?? { ownerId: null, queue: new Set<QueuedAcquisition>() };
    this.locksBySessionId.set(sessionId, lock);
    return await new Promise<T>((resolve, reject) => {
      let phase: 'queued' | 'acquired' | 'cancelled' = 'queued';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const removeQueued = () => {
        if (timer !== undefined) clearTimeout(timer);
        lock.queue.delete(acquisition);
      };
      const acquisition: QueuedAcquisition = {
        start: () => {
          if (phase !== 'queued') return;
          phase = 'acquired';
          removeQueued();
          const ownerId = Symbol('connected-service-session-auth-switch-lock-owner');
          lock.ownerId = ownerId;
          void this.runAsOwner(sessionId, lock, ownerId, parentOwners, operation).then(resolve, reject);
        },
        cancel: (reason) => {
          if (phase !== 'queued') return;
          phase = 'cancelled';
          removeQueued();
          reject(new ConnectedServiceSessionAuthSwitchAcquisitionError(sessionId, reason));
        },
      };
      if (lock.ownerId === null) {
        acquisition.start();
      } else {
        lock.queue.add(acquisition);
        if (bound.kind === 'bounded') {
          timer = setTimeout(() => acquisition.cancel('timed_out'), bound.timeoutMs);
        }
      }
    });
  }

  clearSession(sessionId: string): void {
    const lock = this.locksBySessionId.get(sessionId);
    if (!lock) return;
    for (const acquisition of lock.queue) acquisition.cancel('session_stopped');
    // Runner exit or Stop is not cancellation of an in-flight auth transition. An active
    // owner may still be unwinding: keep its lock and reentrant capability until its own
    // finally block releases them, so a later request cannot run concurrently with it.
  }

  private async runAsOwner<T>(
    sessionId: string,
    lock: SessionLock,
    ownerId: symbol,
    parentOwners: ReadonlyArray<ActiveSessionLockOwner>,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await activeSessionLockOwners.run([
        ...parentOwners,
        { registry: this, sessionId, ownerId },
      ], async () => await operation());
    } finally {
      lock.ownerId = null;
      const next = lock.queue.values().next().value;
      if (next) next.start();
      else this.locksBySessionId.delete(sessionId);
    }
  }

  /**
   * Whether another transition holds or awaits this session's lock. The calling async context's
   * own hold does not count, because its re-entry runs at once.
   */
  isHeldByAnotherOwner(sessionId: string): boolean {
    return this.locksBySessionId.has(sessionId) && !this.hasActiveOwner(sessionId);
  }

  private hasActiveOwner(sessionId: string): boolean {
    const owners = activeSessionLockOwners.getStore();
    const ownerId = this.locksBySessionId.get(sessionId)?.ownerId;
    return ownerId != null && (owners?.some((owner) => (
      owner.registry === this
      && owner.sessionId === sessionId
      && owner.ownerId === ownerId
    )) ?? false);
  }
}

export type ConnectedServiceSessionAuthSwitchCore = Readonly<{
  run<T>(params: Readonly<{
    sessionId: string;
    reason: ConnectedServiceSessionAuthSwitchReason;
    execute: () => Promise<T>;
  }>): Promise<T>;
  clearSession(sessionId: string): void;
}>;

export function createConnectedServiceSessionAuthSwitchCore(params?: Readonly<{
  locks?: ConnectedServiceSessionAuthSwitchLockRegistry;
}>): ConnectedServiceSessionAuthSwitchCore {
  const locks = params?.locks ?? new ConnectedServiceSessionAuthSwitchLockRegistry();
  return {
    async run<T>(input: Readonly<{
      sessionId: string;
      reason: ConnectedServiceSessionAuthSwitchReason;
      execute: () => Promise<T>;
    }>): Promise<T> {
      void input.reason;
      return await locks.runExclusive(input.sessionId, input.execute);
    },
    clearSession(sessionId: string): void {
      locks.clearSession(sessionId);
    },
  };
}
