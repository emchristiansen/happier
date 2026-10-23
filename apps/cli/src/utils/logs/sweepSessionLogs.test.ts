import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { sweepSessionLogs } from './sweepSessionLogs';

const DAY_MS = 24 * 60 * 60 * 1000;

// Pids above Linux pid_max (2^22) and macOS PID_MAX can never be alive.
const deadPid = (offset: number): number => 4_200_000 + offset;

function sessionLogName(minute: number, pid: number): string {
  return `2026-01-01-10-${String(minute).padStart(2, '0')}-00-pid-${pid}.log`;
}

async function writeLog(dir: string, name: string, ageMs: number): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `${name}\n`, 'utf8');
  const mtime = new Date(Date.now() - ageMs);
  await utimes(path, mtime, mtime);
}

async function writeExitReport(logsDir: string, file: string, report: Record<string, unknown>): Promise<void> {
  const dir = join(logsDir, 'session-exit');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(report), 'utf8');
}

async function listLogs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.log')).sort();
}

describe('sweepSessionLogs', () => {
  it('deletes exactly the dead, old, out-of-budget, non-crashed session logs', async () => {
    await withTempDir('happier-cli-sweep-session-logs-', async (logsDir) => {
      const env = { HAPPIER_SESSION_LOG_KEEP_COUNT: '2', HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '1' };

      // Newest-N by name (budget 2): kept even though old and dead.
      const newestA = sessionLogName(59, deadPid(59));
      const newestB = sessionLogName(58, deadPid(58));
      // Beyond the budget but recently modified: kept by the age floor.
      const recent = sessionLogName(10, deadPid(10));
      // Beyond the budget, old, but its runner is alive: kept.
      const live = sessionLogName(11, process.pid);
      // Beyond the budget, old, dead, but the newest crashed runner: kept.
      const crashedKept = sessionLogName(12, deadPid(12));
      // An older crash beyond the crashed budget (1): deleted.
      const crashedEvicted = sessionLogName(13, deadPid(13));
      // A clean exit gets no crash protection: deleted.
      const cleanExit = sessionLogName(14, deadPid(14));
      // Ordinary dead, old, out-of-budget logs: deleted.
      const deletedA = sessionLogName(1, deadPid(1));
      const deletedB = sessionLogName(2, deadPid(2));
      // No parseable pid: the writer is unknown, so (a) cannot hold and it is kept even when old.
      const noPidOld = '2026-01-01-09-00-00-legacy.log';
      // No parseable pid but recent: kept.
      const noPidRecent = '2026-01-01-09-01-00-legacy.log';
      // Daemon logs are never session logs, whatever their age.
      const daemonLog = '2026-01-01-08-00-00-pid-4200999-daemon.log';

      for (const name of [newestA, newestB, live, crashedKept, crashedEvicted, cleanExit, deletedA, deletedB, noPidOld, daemonLog]) {
        await writeLog(logsDir, name, 30 * DAY_MS);
      }
      await writeLog(logsDir, recent, 1 * DAY_MS);
      await writeLog(logsDir, noPidRecent, 1 * DAY_MS);

      await writeExitReport(logsDir, 'a-crashed-new.json', { pid: deadPid(12), observedAt: 20, code: 1 });
      await writeExitReport(logsDir, 'z-crashed-old.json', { pid: deadPid(13), observedAt: 10, signal: 'SIGKILL' });
      await writeExitReport(logsDir, 'clean.json', { pid: deadPid(14), observedAt: 30, code: 0 });

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([
        noPidOld,
        noPidRecent,
        recent,
        live,
        crashedKept,
        newestB,
        newestA,
        daemonLog,
      ].sort());
      expect(result).toEqual({ outcome: 'swept', deleted: 4 });
    });
  });

  // The four delete conditions are joined by AND. Each case below fails exactly one of them for the
  // variant log while a control log fails none, so an OR anywhere in the rule deletes the variant.
  // Condition (a) fails two ways: a live writer, and a writer that cannot be identified.
  describe.each([
    {
      condition: '(a) its writer is alive',
      variant: sessionLogName(2, process.pid),
      ageMs: 30 * DAY_MS,
      env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0' },
      crashReportPid: null,
    },
    {
      condition: "(a') its writer is unknown",
      variant: '2026-01-01-10-02-00-legacy.log',
      ageMs: 30 * DAY_MS,
      env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0' },
      crashReportPid: null,
    },
    {
      condition: '(b) it is younger than the minimum age',
      variant: sessionLogName(2, deadPid(2)),
      ageMs: 1 * DAY_MS,
      env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0' },
      crashReportPid: null,
    },
    {
      condition: '(c) it is among the newest session logs by name',
      variant: sessionLogName(59, deadPid(59)),
      ageMs: 30 * DAY_MS,
      env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '1' },
      crashReportPid: null,
    },
    {
      condition: '(d) it is a kept crashed-runner log',
      variant: sessionLogName(2, deadPid(2)),
      ageMs: 30 * DAY_MS,
      env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '1' },
      crashReportPid: deadPid(2),
    },
  ])('when only $condition', ({ variant, ageMs, env, crashReportPid }) => {
    it('keeps that log and deletes a control log that meets every delete condition', async () => {
      await withTempDir('happier-cli-sweep-session-logs-single-', async (logsDir) => {
        const control = sessionLogName(1, deadPid(1));
        await writeLog(logsDir, control, 30 * DAY_MS);
        await writeLog(logsDir, variant, ageMs);
        if (crashReportPid !== null) {
          await writeExitReport(logsDir, 'crash.json', { pid: crashReportPid, observedAt: 1, code: 1 });
        }

        const result = await sweepSessionLogs({ logsDir, env });

        expect(await listLogs(logsDir)).toEqual([variant]);
        expect(result).toEqual({ outcome: 'swept', deleted: 1 });
      });
    });
  });

  it('never deletes a protected path, such as the daemon current log', async () => {
    await withTempDir('happier-cli-sweep-session-logs-protected-', async (logsDir) => {
      const protectedLog = sessionLogName(1, deadPid(1));
      const unprotected = sessionLogName(2, deadPid(2));
      await writeLog(logsDir, protectedLog, 30 * DAY_MS);
      await writeLog(logsDir, unprotected, 30 * DAY_MS);

      await sweepSessionLogs({
        logsDir,
        protectedPaths: [join(logsDir, protectedLog)],
        env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0' },
      });

      expect(await listLogs(logsDir)).toEqual([protectedLog]);
    });
  });

  it('honours the minimum-age override and falls back to the 14-day default on bad values', async () => {
    await withTempDir('happier-cli-sweep-session-logs-age-', async (logsDir) => {
      const tenDaysOld = sessionLogName(1, deadPid(1));
      const fiveDaysOld = sessionLogName(2, deadPid(2));
      const write = async () => {
        await writeLog(logsDir, tenDaysOld, 10 * DAY_MS);
        await writeLog(logsDir, fiveDaysOld, 5 * DAY_MS);
      };

      await write();
      await sweepSessionLogs({ logsDir, env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_SESSION_LOG_MIN_AGE_DAYS: 'nope' } });
      expect(await listLogs(logsDir)).toEqual([tenDaysOld, fiveDaysOld].sort());

      await sweepSessionLogs({ logsDir, env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '-3' } });
      expect(await listLogs(logsDir)).toEqual([tenDaysOld, fiveDaysOld].sort());

      await sweepSessionLogs({ logsDir, env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '7' } });
      expect(await listLogs(logsDir)).toEqual([fiveDaysOld]);

      await sweepSessionLogs({ logsDir, env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_SESSION_LOG_MIN_AGE_DAYS: '0.5' } });
      expect(await listLogs(logsDir)).toEqual([]);
    });
  });

  it('honours the session and crashed keep-count overrides', async () => {
    await withTempDir('happier-cli-sweep-session-logs-counts-', async (logsDir) => {
      const names = [1, 2, 3, 4].map((minute) => sessionLogName(minute, deadPid(minute)));
      for (const name of names) await writeLog(logsDir, name, 30 * DAY_MS);
      await writeExitReport(logsDir, 'crash-1.json', { pid: deadPid(1), observedAt: 1, code: 2 });
      await writeExitReport(logsDir, 'crash-2.json', { pid: deadPid(2), observedAt: 2, code: 2 });

      await sweepSessionLogs({
        logsDir,
        env: { HAPPIER_SESSION_LOG_KEEP_COUNT: '1', HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '0' },
      });

      expect(await listLogs(logsDir)).toEqual([names[3]]);
    });
  });

  it('keeps everything under the default budget and age when no overrides are set', async () => {
    await withTempDir('happier-cli-sweep-session-logs-defaults-', async (logsDir) => {
      const names = [1, 2, 3].map((minute) => sessionLogName(minute, deadPid(minute)));
      for (const name of names) await writeLog(logsDir, name, 30 * DAY_MS);

      await sweepSessionLogs({ logsDir, env: { HAPPIER_SESSION_LOG_KEEP_COUNT: 'bogus' } });

      expect(await listLogs(logsDir)).toEqual(names.sort());
    });
  });

  it('never throws when the logs dir is missing', async () => {
    await withTempDir('happier-cli-sweep-session-logs-missing-', async (root) => {
      await expect(sweepSessionLogs({ logsDir: join(root, 'absent'), env: {} })).resolves.toEqual({ outcome: 'swept', deleted: 0 });
    });
  });
});
