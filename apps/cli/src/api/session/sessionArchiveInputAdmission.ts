import { PendingInputRetryEpisode } from './pendingInputRetryEpisode';
import { readSessionArchiveState } from '@/session/services/readSessionArchiveState';
import { AsyncLock } from '@/utils/lock';
import { delayUnrefAbortable } from '@/utils/time';
import { logger } from '@/ui/logger';

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
    requestArchivedStop: () => Promise<unknown>;
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
          if (epoch !== this.opts.connectionEpoch() || archive === 'unavailable') {
            this.retry.failed();
            return { kind: 'waiting' } as const;
          }
          if (archive === 'archived') {
            this.archived = true;
            // Waiting for our own physical exit would deadlock this delivery boundary.
            // The existing stop owner keeps all identity/fence checks and reports uncertainty.
            void Promise.resolve().then(this.opts.requestArchivedStop).catch(() => {
              logger.debug('[archiveAdmission] archived physical stop request failed; error details not shown');
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
