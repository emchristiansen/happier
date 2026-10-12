import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { acquireSessionRunnerLock, readSessionRunnerLockStatus } from '@/daemon/sessionRunnerLock';
import { logger } from '@/ui/logger';
import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfiguration();
});

describe('runBackendSessionCliCommand (session runner lock)', () => {
  it('refuses an existing Session without entering its runner or releasing the current owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-existing-runner-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    const sessionId = 'session-already-running';
    const lock = await acquireSessionRunnerLock({ sessionId });
    if (!lock.ok) throw new Error('Unable to establish the running Session fixture');
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('runner-exit'); });
    let runnerLoaded = false;
    try {
      await expect(runBackendSessionCliCommand({
        context: { args: ['codex', '--existing-session', sessionId], rawArgv: [], terminalRuntime: null },
        loadRun: async () => {
          runnerLoaded = true;
          return async () => {};
        },
      })).rejects.toThrow('runner-exit');
      expect(runnerLoaded).toBe(false);
      await expect(readSessionRunnerLockStatus({ sessionId })).resolves.toMatchObject({
        ok: true, lock: { sessionId, pid: process.pid, acquiredAtMs: lock.acquiredAtMs },
      });
    } finally {
      await lock.release();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
