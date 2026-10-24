import { PendingInputRetryEpisode } from './pendingInputRetryEpisode';
import { readSessionArchiveState } from '@/session/services/readSessionArchiveState';
import { AsyncLock } from '@/utils/lock';
import { delayUnrefAbortable } from '@/utils/time';
import { logger } from '@/ui/logger';

export type ArchivedSessionCleanupOutcome = Readonly<{ kind: 'requested' | 'unavailable' }>;
export type RequestArchivedSessionCleanup = () => Promise<ArchivedSessionCleanupOutcome>;

/** Owns only archive admission; materialization and settings retain their retry episodes. */
export class SessionArchiveInputAdmission {
  private readonly readLock = new AsyncLock();
  private readonly retry = new PendingInputRetryEpisode('archive_admission');
  private archived = false;

  constructor(private readonly opts: Readonly<{
    token: string;
    sessionId: string;
    lifetime: AbortSignal;
    connectionEpoch: () => number;
    waitForFreshEvent: (signal: AbortSignal) => Promise<boolean>;
    requestArchivedStop: RequestArchivedSessionCleanup;
  }>) {}

  async wait(signal: AbortSignal): Promise<boolean> {
    const lifetime = AbortSignal.any([signal, this.opts.lifetime]);
    while (!lifetime.aborted && !this.archived) {
      const pass = new AbortController();
      const passSignal = AbortSignal.any([lifetime, pass.signal]);
      // Arm before the read: an event arriving during a failed request must not be lost.
      const wake = this.opts.waitForFreshEvent(passSignal).then((updated) => {
        if (updated && !passSignal.aborted) this.retry.freshEvent();
        return updated;
      });
      try {
        const outcome = await this.readLock.inLock(async () => {
          if (lifetime.aborted || this.archived) return { kind: 'refused' } as const;
          const state = this.retry.beginAttempt();
          if (state.status !== 'retrying' || state.retryAtMs > Date.now()) return { kind: 'waiting' } as const;
          const epoch = this.opts.connectionEpoch();
          const archive = await readSessionArchiveState({
            token: this.opts.token, sessionId: this.opts.sessionId, signal: passSignal,
          });
          if (lifetime.aborted) return { kind: 'refused' } as const;
          const epochChanged = epoch !== this.opts.connectionEpoch();
          if (epochChanged || archive.kind === 'unavailable') {
            const serverRetryAfterMs = archive.kind === 'unavailable' ? archive.retryAfterMs : undefined;
            const retryState = this.retry.failed(serverRetryAfterMs);
            // Without this line a runner can wait here indefinitely with nothing in its file log:
            // each wake renews the retry budget, so exhaustion alone is not enough to see it.
            logger.infoFile('[archiveAdmission] archive state read failed; retrying', {
              sessionId: this.opts.sessionId,
              cause: epochChanged ? 'connection_epoch_changed' : 'unavailable',
              ...(serverRetryAfterMs !== undefined ? { serverRetryAfterMs } : {}),
              status: retryState.status,
              ...(retryState.status === 'idle' ? {} : { failedAttempts: retryState.failedAttempts }),
              ...(retryState.status === 'retrying'
                ? { retryInMs: Math.max(0, retryState.retryAtMs - Date.now()) }
                : { retryOn: 'next_wake' }),
            });
            return { kind: 'waiting' } as const;
          }
          if (archive.kind === 'archived') {
            this.archived = true;
            // Waiting for our own physical exit would deadlock this delivery boundary.
            // Cleanup is bound to the observing runner, never rediscovered by session ID.
            void Promise.resolve().then(this.opts.requestArchivedStop).then((outcome) => {
              if (outcome.kind === 'unavailable') {
                logger.infoFile('[archiveAdmission] exact local cleanup owner unavailable; input refused, physical cleanup unconfirmed');
              }
            }).catch(() => {
              logger.infoFile('[archiveAdmission] exact local cleanup request failed; input refused, physical cleanup unconfirmed; error details not shown');
            });
            return { kind: 'refused' } as const;
          }
          this.retry.settled();
          return { kind: 'allowed', epoch } as const;
        });
        if (outcome.kind === 'refused') return false;
        if (outcome.kind === 'allowed') {
          if (outcome.epoch !== this.opts.connectionEpoch()) continue;
          return !lifetime.aborted && !this.archived;
        }
        const state = this.retry.state;
        if (state.status === 'retrying') {
          await Promise.race([
            wake,
            delayUnrefAbortable(Math.max(1, state.retryAtMs - Date.now()), passSignal),
          ]);
        } else if (!await wake) {
          return false;
        }
      } finally {
        pass.abort();
      }
    }
    return false;
  }
}
