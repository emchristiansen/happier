import { logger } from '@/ui/logger';

const MAX_FAILED_ATTEMPTS = 12;
const EPISODE_WINDOW_MS = 30 * 60_000;
const MAX_LOCAL_DELAY_MS = 300_000;

type EpisodeProgress = Readonly<{
  startedAtMs: number;
  deadlineMs: number;
  failedAttempts: number;
}>;

export type PendingInputRetryState =
  | Readonly<{ status: 'idle' }>
  | (EpisodeProgress & Readonly<{ status: 'retrying'; retryAtMs: number }>)
  | (EpisodeProgress & Readonly<{ status: 'exhausted'; reason: 'attempt_limit' | 'deadline' }>);

/** Shared policy only: each existing owner retains its single flight, timer and cancellation. */
export class PendingInputRetryEpisode {
  private current: PendingInputRetryState = { status: 'idle' };
  private serverNotBeforeMs = 0;

  constructor(private readonly operation: 'materialization' | 'account_settings') {}

  get state(): PendingInputRetryState { return this.current; }

  freshEvent(): void {
    // An event renews the budget, never permission to shorten a server's lower bound.
    const now = Date.now();
    this.current = {
      status: 'retrying', startedAtMs: now, deadlineMs: now + EPISODE_WINDOW_MS,
      failedAttempts: 0, retryAtMs: Math.max(now, this.serverNotBeforeMs),
    };
  }

  settled(): void {
    this.current = { status: 'idle' };
    // A local success (for example a settings envelope) cannot waive server guidance.
  }

  beginAttempt(): PendingInputRetryState {
    const now = Date.now();
    if (this.current.status === 'idle') {
      this.current = {
        status: 'retrying', startedAtMs: now, deadlineMs: now + EPISODE_WINDOW_MS,
        failedAttempts: 0, retryAtMs: Math.max(now, this.serverNotBeforeMs),
      };
    }
    if (this.current.status === 'retrying' && (
      now >= this.current.deadlineMs || this.current.retryAtMs >= this.current.deadlineMs
    )) this.exhaust('deadline', this.current);
    return this.current;
  }

  failed(retryAfterMs?: number, initialDelayMs = 250): PendingInputRetryState {
    const state = this.current.status === 'idle' ? this.beginAttempt() : this.current;
    if (state.status !== 'retrying') return state;
    const now = Date.now();
    const progress = { ...state, failedAttempts: state.failedAttempts + 1 };
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.serverNotBeforeMs = Math.max(this.serverNotBeforeMs, now + Math.ceil(retryAfterMs));
    }
    const base = Number.isFinite(initialDelayMs) && initialDelayMs > 0 ? initialDelayMs : 250;
    // Positive jitter; cap the complete local delay, then apply the independent server bound.
    const localDelayMs = Math.min(MAX_LOCAL_DELAY_MS, Math.ceil(base * 2 ** (progress.failedAttempts - 1) * (1.1 + Math.random() * 0.2)));
    const retryAtMs = Math.max(now + localDelayMs, this.serverNotBeforeMs);
    if (progress.failedAttempts >= MAX_FAILED_ATTEMPTS) this.exhaust('attempt_limit', progress);
    else if (now >= progress.deadlineMs || retryAtMs >= progress.deadlineMs) this.exhaust('deadline', progress);
    else this.current = { ...progress, status: 'retrying', retryAtMs };
    return this.current;
  }

  private exhaust(reason: 'attempt_limit' | 'deadline', progress: EpisodeProgress): void {
    if (this.current.status === 'exhausted') return;
    this.current = {
      status: 'exhausted', reason, startedAtMs: progress.startedAtMs,
      deadlineMs: progress.deadlineMs, failedAttempts: progress.failedAttempts,
    };
    logger.infoFile('[pendingInput] retry episode exhausted', { operation: this.operation, ...this.current });
  }
}
