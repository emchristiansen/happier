import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { runDaemonLogRetention, trimDaemonLogs } from './daemonLogRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

function daemonLogName(index: number): string {
  return `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${4_300_000 + index}-daemon.log`;
}

function sessionLogName(minute: number): string {
  return `2026-01-01-10-${String(minute).padStart(2, '0')}-00-pid-${4_200_000 + minute}.log`;
}

async function writeOld(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), `${name}\n`, 'utf8');
  const mtime = new Date(Date.now() - 30 * DAY_MS);
  await utimes(join(dir, name), mtime, mtime);
}

async function list(dir: string, suffixFilter: (name: string) => boolean): Promise<string[]> {
  return (await readdir(dir)).filter(suffixFilter).sort();
}

const isDaemonLog = (name: string): boolean => name.endsWith('-daemon.log');
const isSessionLog = (name: string): boolean => name.endsWith('.log') && !isDaemonLog(name);

describe('trimDaemonLogs', () => {
  it('keeps the newest 50 daemon logs by name plus the current one, leaving session logs alone', async () => {
    await withTempDir('happier-cli-trim-daemon-logs-', async (logsDir) => {
      const names = Array.from({ length: 60 }, (_, index) => daemonLogName(index));
      for (const name of names) await writeOld(logsDir, name);
      const session = sessionLogName(1);
      await writeOld(logsDir, session);
      // The oldest name stands in for the running daemon's log: protected despite being out of budget.
      const current = names[0]!;

      const result = await trimDaemonLogs({ logsDir, currentLogPath: join(logsDir, current), env: {} });

      expect(await list(logsDir, isDaemonLog)).toEqual([current, ...names.slice(10)].sort());
      expect(await list(logsDir, isSessionLog)).toEqual([session]);
      expect(result).toEqual({ pruned: 9 });
    });
  });

  it('honours HAPPIER_DAEMON_LOG_KEEP_COUNT', async () => {
    await withTempDir('happier-cli-trim-daemon-logs-env-', async (logsDir) => {
      const names = Array.from({ length: 5 }, (_, index) => daemonLogName(index));
      for (const name of names) await writeOld(logsDir, name);

      await trimDaemonLogs({ logsDir, currentLogPath: join(logsDir, names[4]!), env: { HAPPIER_DAEMON_LOG_KEEP_COUNT: '2' } });

      expect(await list(logsDir, isDaemonLog)).toEqual(names.slice(3));
    });
  });
});

describe('runDaemonLogRetention', () => {
  it('trims daemon logs and sweeps session logs in one pass', async () => {
    await withTempDir('happier-cli-daemon-log-retention-', async (logsDir) => {
      const daemonNames = Array.from({ length: 3 }, (_, index) => daemonLogName(index));
      for (const name of daemonNames) await writeOld(logsDir, name);
      const sessionNames = [1, 2].map(sessionLogName);
      for (const name of sessionNames) await writeOld(logsDir, name);

      const result = await runDaemonLogRetention({
        logsDir,
        currentLogPath: join(logsDir, daemonNames[2]!),
        env: { HAPPIER_DAEMON_LOG_KEEP_COUNT: '1', HAPPIER_SESSION_LOG_KEEP_COUNT: '1' },
      });

      expect(await list(logsDir, isDaemonLog)).toEqual([daemonNames[2]]);
      expect(await list(logsDir, isSessionLog)).toEqual([sessionNames[1]]);
      expect(result).toEqual({ daemonLogs: { pruned: 2 }, sessionLogs: { outcome: 'swept', deleted: 1 } });
    });
  });

  it('still trims daemon logs when the session sweep cannot establish crash evidence', async () => {
    await withTempDir('happier-cli-daemon-log-retention-skip-', async (logsDir) => {
      const daemonNames = Array.from({ length: 3 }, (_, index) => daemonLogName(index));
      for (const name of daemonNames) await writeOld(logsDir, name);
      const session = sessionLogName(1);
      await writeOld(logsDir, session);
      // A file where the session-exit directory should be: listing it fails with ENOTDIR,
      // which is not "absent", so crash evidence is unavailable.
      await writeFile(join(logsDir, 'session-exit'), 'not a directory', 'utf8');

      const result = await runDaemonLogRetention({
        logsDir,
        currentLogPath: join(logsDir, daemonNames[2]!),
        env: { HAPPIER_DAEMON_LOG_KEEP_COUNT: '1', HAPPIER_SESSION_LOG_KEEP_COUNT: '0' },
      });

      expect(await list(logsDir, isDaemonLog)).toEqual([daemonNames[2]]);
      expect(await list(logsDir, isSessionLog)).toEqual([session]);
      expect(result.sessionLogs).toEqual({ outcome: 'skipped', reason: 'crash_evidence_unavailable', deleted: 0 });
    });
  });

  it('never deletes the current log when it is the only daemon log and the budget is zero', async () => {
    await withTempDir('happier-cli-daemon-log-retention-zero-', async (logsDir) => {
      await mkdir(logsDir, { recursive: true });
      const current = daemonLogName(0);
      await writeOld(logsDir, current);

      await runDaemonLogRetention({ logsDir, currentLogPath: join(logsDir, current), env: { HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' } });

      expect(await list(logsDir, isDaemonLog)).toEqual([current]);
    });
  });
});
