import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { sweepSessionLogs } from './sweepSessionLogs';

// The filesystem is the boundary: faults are injected only into the named paths' reads; every
// other call reaches the real filesystem.
const { failingPaths } = vi.hoisted(() => ({
  failingPaths: new Map<string, string>(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const failIfInjected = (path: unknown): void => {
    const code = failingPaths.get(String(path));
    if (code === undefined) return;
    throw Object.assign(new Error(`${code}: injected fault, '${String(path)}'`), { code });
  };
  return {
    ...actual,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      failIfInjected(path);
      return await (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
    readdir: (async (path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
      failIfInjected(path);
      return await (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readdir,
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Pids above Linux pid_max (2^22) and macOS PID_MAX can never be alive.
const deadPid = (offset: number): number => 4_200_000 + offset;

function sessionLogName(minute: number, pid: number): string {
  return `2026-01-01-10-${String(minute).padStart(2, '0')}-00-pid-${pid}.log`;
}

async function writeOldLog(dir: string, name: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `${name}\n`, 'utf8');
  const mtime = new Date(Date.now() - 30 * DAY_MS);
  await utimes(path, mtime, mtime);
}

async function writeExitReportRaw(logsDir: string, file: string, content: string): Promise<string> {
  const dir = join(logsDir, 'session-exit');
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, content, 'utf8');
  return path;
}

async function listLogs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.log')).sort();
}

// Every log is old, dead and outside the newest-N budget, so only crash retention can keep one.
const env = { HAPPIER_SESSION_LOG_KEEP_COUNT: '0', HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '1' };

describe('sweepSessionLogs crash evidence', () => {
  afterEach(() => {
    failingPaths.clear();
  });

  it('deletes nothing when a crash report cannot be read, so its log keeps its protection', async () => {
    await withTempDir('happier-cli-sweep-crash-unreadable-', async (logsDir) => {
      const crashed = sessionLogName(2, deadPid(2));
      const control = sessionLogName(1, deadPid(1));
      await writeOldLog(logsDir, crashed);
      await writeOldLog(logsDir, control);
      const report = await writeExitReportRaw(
        logsDir,
        'crash.json',
        JSON.stringify({ pid: deadPid(2), observedAt: Date.now(), code: 1 }),
      );
      failingPaths.set(report, 'EACCES');

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([control, crashed].sort());
      expect(result).toEqual({ outcome: 'skipped', reason: 'crash_evidence_unavailable', deleted: 0 });
    });
  });

  it('deletes nothing when the session-exit scan fails', async () => {
    await withTempDir('happier-cli-sweep-crash-scan-failed-', async (logsDir) => {
      const crashed = sessionLogName(2, deadPid(2));
      const control = sessionLogName(1, deadPid(1));
      await writeOldLog(logsDir, crashed);
      await writeOldLog(logsDir, control);
      await writeExitReportRaw(logsDir, 'crash.json', JSON.stringify({ pid: deadPid(2), observedAt: Date.now(), code: 1 }));
      failingPaths.set(join(logsDir, 'session-exit'), 'EIO');

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([control, crashed].sort());
      expect(result).toEqual({ outcome: 'skipped', reason: 'crash_evidence_unavailable', deleted: 0 });
    });
  });

  it('still deletes an eligible log when session-exit is absent', async () => {
    await withTempDir('happier-cli-sweep-crash-absent-', async (logsDir) => {
      const control = sessionLogName(1, deadPid(1));
      await writeOldLog(logsDir, control);

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([]);
      expect(result).toEqual({ outcome: 'swept', deleted: 1 });
    });
  });

  it('treats malformed, pidless and clean-exit reports as no crash evidence, not as unavailable evidence', async () => {
    await withTempDir('happier-cli-sweep-crash-malformed-', async (logsDir) => {
      const crashed = sessionLogName(3, deadPid(3));
      const control = sessionLogName(1, deadPid(1));
      await writeOldLog(logsDir, crashed);
      await writeOldLog(logsDir, control);
      await writeExitReportRaw(logsDir, 'malformed.json', '{"pid": 4200001, "code": 1');
      await writeExitReportRaw(logsDir, 'pidless.json', JSON.stringify({ code: 1, observedAt: 5 }));
      await writeExitReportRaw(logsDir, 'clean.json', JSON.stringify({ pid: deadPid(1), code: 0, observedAt: 6 }));
      await writeExitReportRaw(logsDir, 'crash.json', JSON.stringify({ pid: deadPid(3), observedAt: 4, code: 1 }));

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([crashed]);
      expect(result).toEqual({ outcome: 'swept', deleted: 1 });
    });
  });

  it('skips a report that vanishes between the scan and its read', async () => {
    await withTempDir('happier-cli-sweep-crash-vanished-', async (logsDir) => {
      const control = sessionLogName(1, deadPid(1));
      await writeOldLog(logsDir, control);
      const report = await writeExitReportRaw(logsDir, 'gone.json', JSON.stringify({ pid: deadPid(1), observedAt: 1, code: 1 }));
      failingPaths.set(report, 'ENOENT');

      const result = await sweepSessionLogs({ logsDir, env });

      expect(await listLogs(logsDir)).toEqual([]);
      expect(result).toEqual({ outcome: 'swept', deleted: 1 });
    });
  });
});
