import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const {
  evaluateCurrentDaemonOwnerMock,
  restartDaemonAndWaitMock,
  restartAllDaemonSessionRunnersMock,
  requestDaemonSessionRunnerRestartMock,
  evaluateDaemonStartupServiceConflictMock,
  startDaemonMock,
} = vi.hoisted(() => ({
  evaluateCurrentDaemonOwnerMock: vi.fn(async () => ({ kind: 'none' as const })),
  restartDaemonAndWaitMock: vi.fn(async (): Promise<unknown> => true),
  restartAllDaemonSessionRunnersMock: vi.fn(async () => ({
    ok: true,
    mode: 'if_stale',
    requestedCount: 1,
    restartedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    results: [
      {
        ok: true,
        status: 'dry_run_restartable',
        sessionId: 'sess_1',
      },
    ],
  })),
  requestDaemonSessionRunnerRestartMock: vi.fn(async () => ({
    ok: true,
    status: 'dry_run_restartable',
    sessionId: 'sess_1',
  })),
  evaluateDaemonStartupServiceConflictMock: vi.fn(async () => ({ kind: 'none' as const })),
  startDaemonMock: vi.fn(async () => undefined),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: evaluateCurrentDaemonOwnerMock,
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
  return {
    ...actual,
    evaluateDaemonStartupServiceConflict: evaluateDaemonStartupServiceConflictMock,
  };
});

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    restartAllDaemonSessionRunners: restartAllDaemonSessionRunnersMock,
    requestDaemonSessionRunnerRestart: requestDaemonSessionRunnerRestartMock,
  };
});

vi.mock('@/daemon/restartDaemonAndWait', () => ({
  restartDaemonAndWait: restartDaemonAndWaitMock,
}));

vi.mock('@/daemon/startDaemon', () => ({
  startDaemon: startDaemonMock,
}));

describe('handleDaemonCliCommand session runner restart controls', () => {
  afterEach(() => {
    evaluateCurrentDaemonOwnerMock.mockReset();
    evaluateCurrentDaemonOwnerMock.mockImplementation(async () => ({ kind: 'none' as const }));
    restartDaemonAndWaitMock.mockReset();
    restartDaemonAndWaitMock.mockImplementation(async () => true);
    restartAllDaemonSessionRunnersMock.mockReset();
    restartAllDaemonSessionRunnersMock.mockImplementation(async () => ({
      ok: true,
      mode: 'if_stale',
      requestedCount: 1,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [
        {
          ok: true,
          status: 'dry_run_restartable',
          sessionId: 'sess_1',
        },
      ],
    }));
    requestDaemonSessionRunnerRestartMock.mockReset();
    requestDaemonSessionRunnerRestartMock.mockImplementation(async () => ({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess_1',
    }));
    evaluateDaemonStartupServiceConflictMock.mockReset();
    evaluateDaemonStartupServiceConflictMock.mockImplementation(async () => ({ kind: 'none' as const }));
    startDaemonMock.mockReset();
    startDaemonMock.mockImplementation(async () => undefined);
    vi.restoreAllMocks();
    vi.resetModules();
  }, 60_000);

  it('keeps daemon restart default behavior as no runner restart', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart'],
        rawArgv: ['happier', 'daemon', 'restart'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:0/);
    } finally {
      exitSpy.mockRestore();
    }

    expect(restartDaemonAndWaitMock).toHaveBeenCalledWith({
      stopSessions: false,
      takeover: false,
    });
  }, 60_000);

  it('passes restart-session-runners intent to daemon restart with force-current-cli mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart', '--restart-session-runners'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:0/);
    } finally {
      exitSpy.mockRestore();
    }

    expect(restartDaemonAndWaitMock).toHaveBeenCalledWith({
      stopSessions: false,
      takeover: false,
      restartSessionRunners: true,
      restartSessionRunnersMode: 'force_current_cli',
    });
  }, 60_000);

  it('prints daemon restart runner refresh summary in JSON output', async () => {
    restartDaemonAndWaitMock.mockImplementation(async () => ({
      ok: true,
      sessionRunnerRestart: {
        ok: true,
        mode: 'force_current_cli',
        requestedCount: 2,
        restartedCount: 1,
        skippedCount: 1,
        failedCount: 0,
        results: [
          { ok: true, status: 'restarted', sessionId: 'sess_1' },
          { ok: true, status: 'already_current', sessionId: 'sess_2' },
        ],
      },
    }));
    const output = captureStdoutJsonOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart', '--restart-session-runners', '--json'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners', '--json'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:0/);
    } finally {
      exitSpy.mockRestore();
      output.restore();
    }

    expect(output.json()).toEqual(expect.objectContaining({
      ok: true,
      status: 'restarted',
      sessionRunnerRestart: expect.objectContaining({
        ok: true,
        requestedCount: 2,
        restartedCount: 1,
        skippedCount: 1,
        failedCount: 0,
      }),
    }));
  }, 60_000);

  it('reports daemon restart runner refresh failures distinctly in text output', async () => {
    restartDaemonAndWaitMock.mockImplementation(async () => ({
      ok: false,
      sessionRunnerRestart: {
        ok: false,
        mode: 'force_current_cli',
        requestedCount: 2,
        restartedCount: 1,
        skippedCount: 0,
        failedCount: 1,
        results: [
          { ok: true, status: 'restarted', sessionId: 'sess_1' },
          {
            ok: false,
            status: 'spawn_failed',
            sessionId: 'sess_2',
            reasonCode: 'missing_credentials',
          },
        ],
      },
    }));
    const output = captureConsoleText();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart', '--restart-session-runners'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:1/);
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }

    expect(output.text()).not.toContain('Failed to restart daemon');
    expect(output.text()).toContain('Session runner restart failed after daemon restart');
    expect(output.text()).toContain('1 restarted, 0 skipped, 1 failed');
    expect(output.text()).toContain('sess_2: spawn_failed (missing_credentials)');
  }, 60_000);

  it('reports daemon restart runner refresh failures distinctly in JSON output', async () => {
    restartDaemonAndWaitMock.mockImplementation(async () => ({
      ok: false,
      sessionRunnerRestart: {
        ok: false,
        mode: 'force_current_cli',
        requestedCount: 1,
        restartedCount: 0,
        skippedCount: 0,
        failedCount: 1,
        results: [
          {
            ok: false,
            status: 'spawn_failed',
            sessionId: 'sess_2',
            reasonCode: 'missing_credentials',
          },
        ],
      },
    }));
    const output = captureStdoutJsonOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart', '--restart-session-runners', '--json'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners', '--json'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:1/);
    } finally {
      exitSpy.mockRestore();
      output.restore();
    }

    expect(output.json()).toEqual(expect.objectContaining({
      ok: false,
      error: 'session_runner_restart_failed_after_daemon_restart',
      message: 'Session runner restart failed after daemon restart',
      sessionRunnerRestart: expect.objectContaining({
        ok: false,
        failedCount: 1,
        results: [
          expect.objectContaining({
            sessionId: 'sess_2',
            status: 'spawn_failed',
            reasonCode: 'missing_credentials',
          }),
        ],
      }),
    }));
  }, 60_000);

  it('rejects daemon restart when runner restart and kill sessions are both requested', async () => {
    const output = captureConsoleText();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart', '--restart-session-runners', '--kill-sessions'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners', '--kill-sessions'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:1/);
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }

    expect(output.text()).toContain('--restart-session-runners');
    expect(output.text()).toContain('--kill-sessions');
    expect(restartDaemonAndWaitMock).not.toHaveBeenCalled();
  }, 60_000);

  it('runs daemon restart-session-runners as a dry-run if-stale bulk request', async () => {
    const output = captureStdoutJsonOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart-session-runners', '--dry-run', '--json'],
        rawArgv: ['happier', 'daemon', 'restart-session-runners', '--dry-run', '--json'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:0/);
    } finally {
      exitSpy.mockRestore();
      output.restore();
    }

    expect(restartAllDaemonSessionRunnersMock).toHaveBeenCalledWith({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    });
    expect(output.json()).toEqual(expect.objectContaining({
      ok: true,
      requestedCount: 1,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    }));
  });

  it('runs daemon restart-session-runners as a dry-run if-stale request for one session', async () => {
    const output = captureStdoutJsonOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'restart-session-runners', '--session-id', 'sess_1', '--dry-run', '--json'],
        rawArgv: ['happier', 'daemon', 'restart-session-runners', '--session-id', 'sess_1', '--dry-run', '--json'],
        terminalRuntime: null,
      })).rejects.toThrow(/exit:0/);
    } finally {
      exitSpy.mockRestore();
      output.restore();
    }

    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    });
    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    expect(output.json()).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess_1',
    }));
  });

  describe('--on-update', () => {
    const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
    let homeDir = '';

    beforeEach(async () => {
      homeDir = await createTempDir('happier-cli-runner-on-update-');
      applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();
    });

    afterEach(async () => {
      restoreEnvValues(envBackup);
      await removeTempDir(homeDir);
    });

    async function runDaemonCommand(args: string[]): Promise<string> {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as never);
      try {
        const { handleDaemonCliCommand } = await import('./daemon');
        await handleDaemonCliCommand({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
        return 'returned';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        exitSpy.mockRestore();
      }
    }

    async function readPersistedSettings(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    }

    it('persists the opt-in without contacting the daemon', async () => {
      const output = captureStdoutJsonOutput();
      let outcome: string;
      try {
        outcome = await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'on', '--json']);
      } finally {
        output.restore();
      }

      expect(outcome).toBe('exit:0');
      expect(await readPersistedSettings()).toEqual(expect.objectContaining({ restartSessionRunnersOnUpdate: true }));
      expect(output.json()).toEqual({ ok: true, restartSessionRunnersOnUpdate: true });
      expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
      expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
    }, 60_000);

    it('turns the opt-in back off', async () => {
      const output = captureConsoleText();
      try {
        expect(await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'on'])).toBe('exit:0');
        expect(await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'off'])).toBe('exit:0');
      } finally {
        output.restore();
      }

      expect(await readPersistedSettings()).toEqual(expect.objectContaining({ restartSessionRunnersOnUpdate: false }));
      expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    }, 60_000);

    it('rejects a value other than on or off without touching settings', async () => {
      const output = captureStdoutJsonOutput();
      let outcome: string;
      try {
        outcome = await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'maybe', '--json']);
      } finally {
        output.restore();
      }

      expect(outcome).toBe('exit:1');
      expect(output.json()).toEqual(expect.objectContaining({ ok: false, error: 'invalid_on_update_value' }));
      expect(existsSync(join(homeDir, 'settings.json'))).toBe(false);
      expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    }, 60_000);

    it('rejects --on-update combined with restart flags instead of silently ignoring them', async () => {
      const output = captureStdoutJsonOutput();
      let outcome: string;
      try {
        outcome = await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'on', '--dry-run', '--json']);
      } finally {
        output.restore();
      }

      expect(outcome).toBe('exit:1');
      expect(output.json()).toEqual(expect.objectContaining({ ok: false, error: 'on_update_conflicting_options' }));
      expect(existsSync(join(homeDir, 'settings.json'))).toBe(false);
      expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
    }, 60_000);

    it('reports a settings write failure as a structured error', async () => {
      // A non-empty directory where settings.json belongs makes the real settings write fail.
      await mkdir(join(homeDir, 'settings.json'));
      await writeFile(join(homeDir, 'settings.json', 'occupied'), 'x');
      const output = captureStdoutJsonOutput();
      let outcome: string;
      try {
        outcome = await runDaemonCommand(['daemon', 'restart-session-runners', '--on-update', 'on', '--json']);
      } finally {
        output.restore();
        // The settings writer's best-effort chmod can strip the directory's search bit.
        await chmod(join(homeDir, 'settings.json'), 0o700);
      }

      expect(outcome).toBe('exit:1');
      expect(output.json()).toEqual(expect.objectContaining({ ok: false, error: 'settings_update_failed' }));
    }, 60_000);
  });
});
