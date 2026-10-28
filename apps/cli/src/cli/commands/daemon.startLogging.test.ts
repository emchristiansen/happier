import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import type { DaemonRunningInspection } from '@/daemon/controlClient';

const {
  checkIfDaemonRunningMock,
  evaluateCurrentDaemonOwnerMock,
  evaluateDaemonStartupServiceConflictMock,
  inspectDaemonRunningStateMock,
  getLatestDaemonLogMock,
  restartDaemonAndWaitMock,
  spawnDetachedDaemonStartSyncMock,
} = vi.hoisted(() => ({
  checkIfDaemonRunningMock: vi.fn(async () => true),
  evaluateCurrentDaemonOwnerMock: vi.fn(async () => ({ kind: 'none' as const })),
  evaluateDaemonStartupServiceConflictMock: vi.fn(async () => ({ kind: 'none' as const })),
  inspectDaemonRunningStateMock: vi.fn(async (): Promise<DaemonRunningInspection> => ({ status: 'not-running' })),
  getLatestDaemonLogMock: vi.fn(async () => null as null | { path: string }),
  restartDaemonAndWaitMock: vi.fn(async (): Promise<boolean | { ok: boolean; status?: 'starting' }> => true),
  spawnDetachedDaemonStartSyncMock: vi.fn(async (): Promise<{ pid?: number; unref: () => void }> => ({ unref: () => {} })),
}));

async function runDaemonStartAndCapture(expectedExitCode: number): Promise<string> {
  const output = captureConsoleText();

  try {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');
      await handleDaemonCliCommand({ args: ['daemon', 'start'], rawArgv: [], terminalRuntime: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const expectedToken = `exit:${expectedExitCode}`;
      if (msg.includes(expectedToken)) {
        // ok
      } else {
        const vitestExitMatch = msg.match(/process\.exit unexpectedly called with "(\d+)"/u);
        if (vitestExitMatch && vitestExitMatch[1] === String(expectedExitCode)) {
          // ok (Vitest intercepted process.exit before our spy)
        } else {
          throw err;
        }
      }
    } finally {
      exitSpy.mockRestore();
    }

    return output.text();
  } finally {
    output.restore();
  }
}

function buildJwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.x`;
}

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: () => spawnDetachedDaemonStartSyncMock(),
}));

vi.mock('@/daemon/restartDaemonAndWait', () => ({
  restartDaemonAndWait: () => restartDaemonAndWaitMock(),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: () => evaluateCurrentDaemonOwnerMock(),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    evaluateDaemonStartupServiceConflict: () => evaluateDaemonStartupServiceConflictMock(),
  };
});

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    checkIfDaemonRunningAndCleanupStaleState: () => checkIfDaemonRunningMock(),
    inspectDaemonRunningStateAndCleanupStaleState: () => inspectDaemonRunningStateMock(),
  };
});

vi.mock('@/ui/logger', () => ({
  getLatestDaemonLog: () => getLatestDaemonLogMock(),
}));

describe('happier daemon start output', () => {
  beforeEach(() => {
    checkIfDaemonRunningMock.mockReset();
    checkIfDaemonRunningMock.mockResolvedValue(true);
    evaluateCurrentDaemonOwnerMock.mockReset();
    evaluateCurrentDaemonOwnerMock.mockResolvedValue({ kind: 'none' });
    evaluateDaemonStartupServiceConflictMock.mockReset();
    evaluateDaemonStartupServiceConflictMock.mockResolvedValue({ kind: 'none' });
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock.mockResolvedValue({ status: 'not-running' } as DaemonRunningInspection);
    getLatestDaemonLogMock.mockReset();
    getLatestDaemonLogMock.mockResolvedValue(null);
    restartDaemonAndWaitMock.mockReset();
    restartDaemonAndWaitMock.mockResolvedValue(true);
    spawnDetachedDaemonStartSyncMock.mockReset();
    spawnDetachedDaemonStartSyncMock.mockResolvedValue({ unref: () => {} });
  });

  it('honors HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS to bound polling (fail-closed)', async () => {
    vi.useFakeTimers();

    const isRunning = vi.fn(async () => false);
    const startedPromise = waitForDaemonRunningWithinBudget({
      isRunning,
      timeoutMs: 1,
      pollMs: 1,
    });

    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(await startedPromise).toBe(false);
    expect(isRunning).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  }, 20_000);

  it('prints server url, active server id, and account subject', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    // This command uses real setTimeout polling when the daemon isn't immediately detected.
    vi.useRealTimers();

    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
    ]);
    const tmp = await createTempDir('happier-daemon-start-');

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_HOME_DIR: tmp,
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      });

      const credDir = join(tmp, 'servers', 'env_test');
      await writeTextFile(
        join(credDir, 'access.key'),
        JSON.stringify(
          {
            encryption: { publicKey: Buffer.from('a').toString('base64'), machineKey: Buffer.from('b').toString('base64') },
            token: buildJwtWithSub('account-123'),
          },
          null,
          2,
        ),
      );

      const stdout = await runDaemonStartAndCapture(0);

      // Starting is a timed step; the details follow as one aligned list.
      expect(stdout).toContain('- [..] Starting daemon');
      expect(stdout).toContain('- [✓] Started daemon');
      expect(stdout).toMatch(/Relay URL: +http:\/\/localhost:4321/u);
      expect(stdout).toMatch(/Relay profile: +env_test/u);
      expect(stdout).toMatch(/Account: +account-123/u);
    } finally {
      envScope.restore();
      await removeTempDir(tmp);
    }
  }, 60_000);

  it('prints structured JSON for daemon start --json on success', async () => {
    vi.useRealTimers();

    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
    ]);
    const tmp = await createTempDir('happier-daemon-start-json-');

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_HOME_DIR: tmp,
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      });

      const credDir = join(tmp, 'servers', 'env_test');
      await writeTextFile(
        join(credDir, 'access.key'),
        JSON.stringify(
          {
            encryption: { publicKey: Buffer.from('a').toString('base64'), machineKey: Buffer.from('b').toString('base64') },
            token: buildJwtWithSub('account-123'),
          },
          null,
          2,
        ),
      );

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        status: string;
        relay: string;
        relayId: string;
        account?: string;
      }>();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as any);
      try {
        const { handleDaemonCliCommand } = await import('./daemon');
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'start', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        })).rejects.toThrow(/exit:0/);

        expect(output.json()).toEqual(expect.objectContaining({
          ok: true,
          status: 'started',
          relay: 'http://localhost:4321',
          relayId: 'env_test',
          account: 'account-123',
        }));
      } finally {
        exitSpy.mockRestore();
        output.restore();
      }
    } finally {
      envScope.restore();
      await removeTempDir(tmp);
    }
  }, 60_000);

  it('marks the start step failed when the daemon cannot be spawned', async () => {
    vi.useRealTimers();
    spawnDetachedDaemonStartSyncMock.mockRejectedValue(new Error('spawn EACCES'));
    vi.resetModules();
    const output = captureConsoleText();
    try {
      const { handleDaemonCliCommand } = await import('./daemon');
      await expect(handleDaemonCliCommand({ args: ['daemon', 'start'], rawArgv: [], terminalRuntime: null }))
        .rejects.toThrow('spawn EACCES');
      expect(output.text()).toContain('- [x] Starting daemon');
    } finally {
      output.restore();
    }
  }, 60_000);

  it('prints the daemon log path when startup does not succeed', async () => {
    vi.useRealTimers();
    checkIfDaemonRunningMock.mockResolvedValue(false);
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope(['HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS']);
    try {
      vi.resetModules();
      envScope.patch({ HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1' });

      const stdout = await runDaemonStartAndCapture(1);

      expect(stdout).toContain('Failed to start daemon');
      expect(stdout).toContain('/tmp/happier-daemon.log');
    } finally {
      envScope.restore();
    }
  }, 60_000);

  it('reports starting instead of failed when the daemon is still within startup grace after the wait budget', async () => {
    vi.useRealTimers();
    checkIfDaemonRunningMock.mockResolvedValue(false);
    inspectDaemonRunningStateMock.mockResolvedValue({
      status: 'starting',
      state: {
        pid: 12345,
        httpPort: 43111,
        controlToken: 'daemon-token',
        startedAt: Date.now(),
        startedWithCliVersion: '0.2.4',
        startedWithPublicReleaseChannel: 'preview',
      },
    });
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope(['HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS']);
    try {
      vi.resetModules();
      envScope.patch({ HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1' });

      const stdout = await runDaemonStartAndCapture(0);

      expect(stdout).toContain('Daemon is still starting in the background');
      expect(stdout).toContain('Relay URL:');
      expect(stdout).toContain('/tmp/happier-daemon.log');
    } finally {
      envScope.restore();
    }
  }, 60_000);

  it('reports starting instead of failed when the detached daemon child is alive but has not written state yet', async () => {
    vi.useRealTimers();
    checkIfDaemonRunningMock.mockResolvedValue(false);
    inspectDaemonRunningStateMock.mockResolvedValue({ status: 'not-running' });
    spawnDetachedDaemonStartSyncMock.mockResolvedValue({
      pid: process.pid,
      unref: () => {},
    });
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope(['HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS']);
    try {
      vi.resetModules();
      envScope.patch({ HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1' });

      const stdout = await runDaemonStartAndCapture(0);

      expect(stdout).toContain('Daemon is still starting in the background');
      expect(stdout).toContain('/tmp/happier-daemon.log');
    } finally {
      envScope.restore();
    }
  }, 60_000);

  it('prints structured JSON for daemon start --json when startup is still in progress after the wait budget', async () => {
    vi.useRealTimers();
    checkIfDaemonRunningMock.mockResolvedValue(false);
    inspectDaemonRunningStateMock.mockResolvedValue({
      status: 'starting',
      state: {
        pid: 12345,
        httpPort: 43111,
        controlToken: 'daemon-token',
        startedAt: Date.now(),
        startedWithCliVersion: '0.2.4',
        startedWithPublicReleaseChannel: 'preview',
      },
    });
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
    ]);
    const tmp = await createTempDir('happier-daemon-starting-json-');

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_HOME_DIR: tmp,
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        status: string;
        relay: string;
        relayId: string;
        latestDaemonLogPath?: string;
      }>();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as any);
      try {
        const { handleDaemonCliCommand } = await import('./daemon');
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'start', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        })).rejects.toThrow(/exit:0/);

        expect(output.json()).toEqual(expect.objectContaining({
          ok: true,
          status: 'starting',
          relay: 'http://localhost:4321',
          relayId: 'env_test',
          latestDaemonLogPath: '/tmp/happier-daemon.log',
        }));
      } finally {
        exitSpy.mockRestore();
        output.restore();
      }
    } finally {
      envScope.restore();
      await removeTempDir(tmp);
    }
  }, 60_000);

  it('prints structured JSON for daemon restart --json when restart fails', async () => {
    vi.useRealTimers();
    restartDaemonAndWaitMock.mockResolvedValue(false);
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope([
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
    ]);

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
        relay: string;
        relayId: string;
        latestDaemonLogPath?: string;
      }>();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as any);
      try {
        const { handleDaemonCliCommand } = await import('./daemon');
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'restart', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        })).rejects.toThrow(/exit:1/);

        expect(output.json()).toEqual({
          ok: false,
          error: 'restart_failed',
          message: 'Failed to restart daemon',
          relay: 'http://localhost:4321',
          relayId: 'env_test',
          latestDaemonLogPath: '/tmp/happier-daemon.log',
        });
      } finally {
        exitSpy.mockRestore();
        output.restore();
      }
    } finally {
      envScope.restore();
    }
  }, 60_000);

  it('prints structured JSON for daemon restart --json when restart is still in progress', async () => {
    vi.useRealTimers();
    restartDaemonAndWaitMock.mockResolvedValue({
      ok: true,
      status: 'starting',
    });
    getLatestDaemonLogMock.mockResolvedValue({ path: '/tmp/happier-daemon.log' });

    const envScope = createEnvKeyScope([
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
    ]);

    try {
      vi.resetModules();
      envScope.patch({
        HAPPIER_SERVER_URL: 'http://localhost:4321',
        HAPPIER_WEBAPP_URL: 'http://localhost:9999',
        HAPPIER_ACTIVE_SERVER_ID: 'env_test',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        status: string;
        relay: string;
        relayId: string;
        latestDaemonLogPath?: string;
      }>();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as any);
      try {
        const { handleDaemonCliCommand } = await import('./daemon');
        await expect(handleDaemonCliCommand({
          args: ['daemon', 'restart', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        })).rejects.toThrow(/exit:0/);

        expect(output.json()).toEqual({
          ok: true,
          status: 'starting',
          relay: 'http://localhost:4321',
          relayId: 'env_test',
          latestDaemonLogPath: '/tmp/happier-daemon.log',
        });
      } finally {
        exitSpy.mockRestore();
        output.restore();
      }
    } finally {
      envScope.restore();
    }
  }, 60_000);
});
