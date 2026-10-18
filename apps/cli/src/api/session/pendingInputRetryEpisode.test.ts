import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingInputRetryEpisode } from './pendingInputRetryEpisode';
import { logger } from '@/ui/logger';

describe('pending input retry budget', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('adds positive jitter and caps local delay after jitter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const episode = new PendingInputRetryEpisode('materialization');
    episode.beginAttempt();
    expect(episode.failed()).toMatchObject({ status: 'retrying', failedAttempts: 1, retryAtMs: 275 });
    episode.freshEvent();
    episode.beginAttempt();
    vi.mocked(Math.random).mockReturnValue(1);
    expect(episode.failed(undefined, 300_000)).toMatchObject({ status: 'retrying', retryAtMs: 300_000 });
  });

  it('retains server lower bounds across fresh events and never caps them to the local maximum', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const episode = new PendingInputRetryEpisode('materialization');
    episode.beginAttempt();
    expect(episode.failed(400_000)).toMatchObject({ status: 'retrying', retryAtMs: 400_000 });
    vi.setSystemTime(100);
    episode.freshEvent();
    expect(episode.beginAttempt()).toMatchObject({ status: 'retrying', failedAttempts: 0, retryAtMs: 400_000 });
    episode.settled();
    expect(episode.beginAttempt()).toMatchObject({ status: 'retrying', retryAtMs: 400_000 });
  });

  it('exhausts immediately when server guidance cannot fit rather than issuing an early attempt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const episode = new PendingInputRetryEpisode('account_settings');
    episode.beginAttempt();
    expect(episode.failed(30 * 60_000)).toMatchObject({
      status: 'exhausted', reason: 'deadline', failedAttempts: 1,
    });
  });

  it('counts twelve failed attempts and retains typed exhaustion until a genuine fresh event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const episode = new PendingInputRetryEpisode('materialization');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ready = episode.beginAttempt();
      expect(ready.status).toBe('retrying');
      const state = episode.failed();
      if (state.status === 'retrying') vi.setSystemTime(state.retryAtMs);
    }
    expect(episode.state).toMatchObject({ status: 'exhausted', reason: 'attempt_limit', failedAttempts: 12 });
    expect(episode.beginAttempt()).toEqual(episode.state);
    expect(diagnostic.mock.calls.filter(([message]) => message === '[pendingInput] retry episode exhausted')).toHaveLength(1);
    episode.freshEvent();
    expect(episode.beginAttempt()).toMatchObject({ status: 'retrying', failedAttempts: 0 });
  });

  it('enforces the absolute deadline even when an in-flight attempt consumed the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const episode = new PendingInputRetryEpisode('materialization');
    episode.beginAttempt();
    vi.setSystemTime(30 * 60_000);
    expect(episode.failed()).toMatchObject({ status: 'exhausted', reason: 'deadline', failedAttempts: 1 });
    expect(episode.beginAttempt()).toMatchObject({ status: 'exhausted' });
  });

  it('starts a renewed window at the event even if the previous request has not settled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const episode = new PendingInputRetryEpisode('account_settings');
    episode.freshEvent();
    vi.setSystemTime(30 * 60_000);
    expect(episode.beginAttempt()).toMatchObject({ status: 'exhausted', reason: 'deadline', failedAttempts: 0 });
  });
  it('retains late server guidance after an observation already exhausted the episode', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const episode = new PendingInputRetryEpisode('account_settings');
    episode.beginAttempt();
    episode.failed(1_790_000);
    vi.setSystemTime(1_790_000);
    expect(episode.beginAttempt()).toMatchObject({ status: 'retrying', retryAtMs: 1_790_000 });
    vi.setSystemTime(1_801_000);
    const exhausted = episode.beginAttempt();
    expect(exhausted).toMatchObject({ status: 'exhausted', reason: 'deadline' });
    vi.setSystemTime(1_803_000);
    expect(episode.failed(120_000)).toEqual(exhausted);
    vi.setSystemTime(1_810_000);
    episode.freshEvent();
    expect(episode.beginAttempt()).toMatchObject({ status: 'retrying', retryAtMs: 1_923_000, failedAttempts: 0 });
  });

});
