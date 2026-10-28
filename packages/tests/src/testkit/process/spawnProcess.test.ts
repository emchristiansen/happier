import * as childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from './processTree';
import { spawnLoggedProcess } from './spawnProcess';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

async function waitForMarker(path: string, timeoutMs = 10_000): Promise<{ childPid: number; grandchildPid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
      const childPid = Number(parsed.childPid);
      const grandchildPid = Number(parsed.grandchildPid);
      if (Number.isInteger(childPid) && childPid > 1 && Number.isInteger(grandchildPid) && grandchildPid > 1) {
        return { childPid, grandchildPid };
      }
    } catch {
      // keep polling until the marker is written
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for marker: ${path}`);
}

describe('spawnLoggedProcess', () => {
  it('bounds steady-state process-table scans while retaining descendant cleanup', async () => {
    if (process.platform === 'win32') return;

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-observation-'));
    // The OS process-list boundary is empty; the polling and cleanup lifecycle stay real.
    const snapshot = vi.mocked(childProcess.spawnSync).mockReturnValue({
      pid: 0, output: [null, '', null], stdout: '', stderr: '', status: 0, signal: null,
    });
    vi.useFakeTimers();
    const proc = spawnLoggedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: rootDir,
      stdoutPath: join(rootDir, 'stdout.log'),
      stderrPath: join(rootDir, 'stderr.log'),
    });

    try {
      vi.advanceTimersByTime(1_000);
      expect(snapshot.mock.calls.length).toBeGreaterThan(0);
      snapshot.mockClear();
      vi.advanceTimersByTime(1_000);
      // Reuse the established 0.3 steady observation budget: four snapshots/second.
      expect(snapshot.mock.calls.length).toBeGreaterThan(0);
      expect(snapshot.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
      snapshot.mockRestore();
      await proc.stop();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('stops detached descendants even after the direct child has already exited', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-'));
    const markerPath = join(rootDir, 'marker.json');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      'setTimeout(() => process.exit(0), 1000);',
      '',
    ].join('\n');

    try {
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);
      await proc.stop();
      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess explicit stop detached descendant cleanup',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('reaps detached descendants when the direct child exits without an explicit stop call', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-autocleanup-'));
    const markerPath = join(rootDir, 'marker.json');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      'setTimeout(() => process.exit(0), 250);',
      '',
    ].join('\n');

    try {
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess auto cleanup direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);

      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess auto cleanup detached descendant',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('can preserve detached descendants across direct child exit until explicit stop', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-preserve-'));
    const markerPath = join(rootDir, 'marker.json');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      'setTimeout(() => process.exit(0), 250);',
      '',
    ].join('\n');

    try {
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
        cleanupDescendantsOnExit: false,
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess preserve direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await proc.stop();
      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess preserve explicit stop detached descendant cleanup',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);
});
