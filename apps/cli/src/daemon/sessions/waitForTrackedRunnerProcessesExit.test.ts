import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Console } from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { readProcessRunState } from '../processRunState';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { isSessionRunnerActive } from './isSessionRunnerActive';

import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

describe('waitForTrackedRunnerProcessesExit', () => {
  it.skipIf(process.platform === 'win32')('preserves custody for a real paused live child', async () => {
    // Development-only owned child; the product runtime is not spawned through system Node.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    const exited = once(child, 'exit');
    const tracked = new Map<number, TrackedSession>([
      [pid, { pid, startedBy: 'terminal', happySessionId: `PID-${pid}`, stopRequestedAtMs: 123 }],
    ]);
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      // Marker files are an external persistence boundary; no marker belongs to this synthetic child.
      removeSessionMarkerFn: async () => {},
    });
    try {
      expect(child.kill('SIGSTOP')).toBe(true);
      expect(await readProcessRunState(pid)).toBe('stopped');
      const request = { runners: [{ pid }], timeoutMs: 0, pollIntervalMs: 0, onExitObserved };
      expect(await waitForTrackedRunnerProcessesExit(request)).toBe(false);
      // Freeze only the clock boundary so a zero-budget old while loop cannot accidentally skip its probe.
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(await isSessionRunnerActive({ sessionId: `PID-${pid}`, trackedSessions: tracked.values() })).toBe(false);
      await waitForExistingSessionExitIfStopRequested({
        sessionId: `PID-${pid}`, pidToTrackedSession: tracked, timeoutMs: 0, pollIntervalMs: 0,
        onExitObserved,
      });
      expect(tracked.has(pid)).toBe(true);
      expect(await readProcessRunState(pid)).toBe('stopped');
    } finally {
      vi.useRealTimers();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  it('settles physical exit only after real exit custody cleanup, recording file-only phases', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    await once(child, 'exit');
    const tracked = new Map<number, TrackedSession>([
      [pid, { pid, startedBy: 'terminal', happySessionId: `PID-${pid}`, stopRequestedAtMs: 123,
        processCommand: 'private-launch-credential' }],
    ]);
    let releaseMarker!: () => void;
    let markerStarted!: () => void;
    const markerPending = new Promise<void>((resolve) => { releaseMarker = resolve; });
    const markerObserved = new Promise<void>((resolve) => { markerStarted = resolve; });
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async () => { markerStarted(); await markerPending; },
    });
    logger.flushSync();
    const previousLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const nodeConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    let completed = false;
    const request = { runners: [{ pid }], timeoutMs: 0, pollIntervalMs: 0, onExitObserved };
    const waiting = waitForTrackedRunnerProcessesExit(request).then((result) => { completed = true; return result; });
    try {
      await Promise.race([markerObserved, waiting]);
      expect(completed).toBe(false);
      expect(tracked.has(pid)).toBe(true);
      releaseMarker();
      expect(await waiting).toBe(true);
      expect(tracked.has(pid)).toBe(false);
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(previousLogLength);
      expect(diagnostic).toContain('[DAEMON STOP] Tracked runner physical exit observed');
      expect(diagnostic).toContain('[DAEMON STOP] Tracked runner exit lifecycle completed');
      expect(diagnostic).not.toContain('private-launch-credential');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      releaseMarker();
      await waiting;
      consoleLog.mockRestore();
      stdout.mockRestore();
    }
  });

  it('waits until every exact runner PID is observed dead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const readRunState = vi.fn()
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('dead')
      .mockResolvedValueOnce('dead');

    try {
      await expect(waitForTrackedRunnerProcessesExit({
      runners: [
        { pid: 101 },
        { pid: 202 },
      ],
      timeoutMs: 50,
      pollIntervalMs: 0,
      readRunState,
      })).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat an apparent identity replacement for a live PID as exit proof', async () => {
    await expect(waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 303 }],
      timeoutMs: 0,
      pollIntervalMs: 0,
      readRunState: vi.fn(async () => 'servable' as const),
    })).resolves.toBe(false);
  });
});
