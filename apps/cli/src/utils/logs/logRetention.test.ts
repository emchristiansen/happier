import { describe, expect, it } from 'vitest';

import {
  DAEMON_LOG_SUFFIX,
  DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT,
  DEFAULT_DAEMON_LOG_KEEP_COUNT,
  DEFAULT_SESSION_LOG_KEEP_COUNT,
  DEFAULT_SESSION_LOG_MIN_AGE_DAYS,
  LOG_FILE_SUFFIX,
  LOG_RETENTION_INTERVAL_MS,
  resolveCrashedSessionLogKeepCount,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
  resolveSessionLogMinAgeMs,
} from './logRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('logRetention', () => {
  it('exposes stable suffix constants', () => {
    expect(DAEMON_LOG_SUFFIX).toBe('-daemon.log');
    expect(LOG_FILE_SUFFIX).toBe('.log');
  });

  it('falls back to defaults when env values are missing or invalid', () => {
    expect(resolveDaemonLogKeepCount({})).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({})).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: 'nope' })).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '-4' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: 'Infinity' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveCrashedSessionLogKeepCount({})).toBe(DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT);
    expect(resolveCrashedSessionLogKeepCount({ HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '-1' })).toBe(DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT);
  });

  it('honors env overrides, flooring fractional values and accepting zero', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '10' })).toBe(10);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '25.9' })).toBe(25);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveCrashedSessionLogKeepCount({ HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '3' })).toBe(3);
  });

  it('resolves the session-log minimum age in days, defaulting to 14 on missing, blank, non-finite or negative values', () => {
    expect(DEFAULT_SESSION_LOG_MIN_AGE_DAYS).toBe(14);
    expect(resolveSessionLogMinAgeMs({})).toBe(14 * DAY_MS);
    for (const bad of ['', '  ', 'nope', '-1', 'Infinity', 'NaN']) {
      expect(resolveSessionLogMinAgeMs({ HAPPIER_SESSION_LOG_MIN_AGE_DAYS: bad })).toBe(14 * DAY_MS);
    }
    expect(resolveSessionLogMinAgeMs({ HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '30' })).toBe(30 * DAY_MS);
    expect(resolveSessionLogMinAgeMs({ HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '0.5' })).toBe(0.5 * DAY_MS);
    expect(resolveSessionLogMinAgeMs({ HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '0' })).toBe(0);
  });

  it('runs the retention pass hourly', () => {
    expect(LOG_RETENTION_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
