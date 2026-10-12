import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { spawnSleepyDetachedProcess, withConfiguredDaemonTestHome, writeDaemonStateFixture } from './testkit/fakeDaemonLifecycle.testkit';

const daemonArgs = ['/repo/dist/index.mjs', 'daemon', 'start-sync'];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('daemon stop confirmed outcomes', () => {
  it('reports no daemon when both state and startup lock are absent', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-stop-absent-' }, async () => {
      const { stopDaemon } = await import('./controlClient');
      await expect(stopDaemon()).resolves.toEqual({ status: 'not_running' });
    });
  });

  it('reports incomplete startup without killing its owner or removing the lock', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-stop-starting-' }, async () => {
      const child = spawnSleepyDetachedProcess(daemonArgs);
      try {
        mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
        writeFileSync(configuration.daemonLockFile, String(child.pid));
        const { stopDaemon } = await import('./controlClient');
        await expect(stopDaemon()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'startup_in_progress', pid: child.pid });
        expect(process.kill(child.pid, 0)).toBe(true);
        expect(existsSync(configuration.daemonLockFile)).toBe(true);
      } finally {
        await child.kill();
      }
    });
  });

  it('reports force stop only after the verified daemon process exits', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-stop-force-' }, async ({ homeDir }) => {
      const child = spawnSleepyDetachedProcess(daemonArgs);
      try {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: 47891 });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('control endpoint unavailable'));
        const { stopDaemon } = await import('./controlClient');
        await expect(stopDaemon()).resolves.toEqual({ status: 'stopped', method: 'force' });
        expect(() => process.kill(child.pid, 0)).toThrow();
      } finally {
        await child.kill();
      }
    });
  });

  it('fails when both force signals leave the verified daemon alive', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-stop-unconfirmed-' }, async ({ homeDir }) => {
      const child = spawnSleepyDetachedProcess(daemonArgs);
      const realKill = process.kill.bind(process);
      try {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: 47891 });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('control endpoint unavailable'));
        const { stopDaemon } = await import('./controlClient');
        // OS signaling is the boundary: classification and persisted state stay real.
        const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid && signal !== 0) return true;
          return realKill(pid, signal);
        });
        await expect(stopDaemon()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'force_kill_unconfirmed', pid: child.pid });
        killSpy.mockRestore();
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });
});
