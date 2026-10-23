import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import {
  readSessionRunnerDebugLog,
  resolveSessionRunnerDebugLogEnv,
  resolveSessionRunnerDebugLogEnvForSpawn,
  SESSION_RUNNER_DEBUG_LOG_DIRNAME,
  writeSessionRunnerDebugLog,
} from './sessionRunnerDebugLog';
import { runDaemonSessionDebugLogCommand } from '@/cli/commands/daemonSessionDebugLog';

describe('per-session runner debug log switch', () => {
  let daemonStateDir: string;

  beforeEach(async () => {
    daemonStateDir = await mkdtemp(join(tmpdir(), 'happier-session-debug-log-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(daemonStateDir, { recursive: true, force: true });
  });

  async function spawnEnvFor(sessionId: string): Promise<NodeJS.ProcessEnv> {
    // The daemon's own environment carries no explicit level, as installed services do.
    return buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin' },
      extraEnv: {
        CUSTOM: 'x',
        ...await resolveSessionRunnerDebugLogEnv({ daemonStateDir, sessionId }),
      },
    });
  }

  it('spawns a flagged session runner at debug level and leaves an unflagged one at its default', async () => {
    await writeSessionRunnerDebugLog({ daemonStateDir, sessionId: 'cmflaggedsession01', enabled: true });

    const flagged = await spawnEnvFor('cmflaggedsession01');
    const unflagged = await spawnEnvFor('cmunflaggedsession2');

    expect(flagged.HAPPIER_LOG_LEVEL).toBe('debug');
    expect(flagged.CUSTOM).toBe('x');
    expect(unflagged.HAPPIER_LOG_LEVEL).toBeUndefined();
    expect(unflagged.CUSTOM).toBe('x');
  });

  it('is read at each spawn, so setting and clearing it needs no daemon restart', async () => {
    const sessionId = 'cmtoggledsession03';
    expect((await spawnEnvFor(sessionId)).HAPPIER_LOG_LEVEL).toBeUndefined();

    await writeSessionRunnerDebugLog({ daemonStateDir, sessionId, enabled: true });
    expect(await readSessionRunnerDebugLog({ daemonStateDir, sessionId })).toBe(true);
    expect((await spawnEnvFor(sessionId)).HAPPIER_LOG_LEVEL).toBe('debug');

    await writeSessionRunnerDebugLog({ daemonStateDir, sessionId, enabled: false });
    expect(await readSessionRunnerDebugLog({ daemonStateDir, sessionId })).toBe(false);
    expect((await spawnEnvFor(sessionId)).HAPPIER_LOG_LEVEL).toBeUndefined();

    // Clearing an already-clear session is not an error.
    await writeSessionRunnerDebugLog({ daemonStateDir, sessionId, enabled: false });
  });

  it('rejects session ids that are not a single path segment', async () => {
    for (const sessionId of ['', '../escape', 'a/b', '.', '..', 'with space']) {
      await expect(writeSessionRunnerDebugLog({ daemonStateDir, sessionId, enabled: true })).rejects.toThrow();
      await expect(resolveSessionRunnerDebugLogEnv({ daemonStateDir, sessionId })).resolves.toEqual({});
    }
  });

  it('sets, reports and clears the switch through the daemon CLI command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = 'cmclisession000004';

    await expect(runDaemonSessionDebugLogCommand(['on', sessionId], { daemonStateDir })).resolves.toBe(0);
    expect((await spawnEnvFor(sessionId)).HAPPIER_LOG_LEVEL).toBe('debug');
    await expect(runDaemonSessionDebugLogCommand(['status', sessionId], { daemonStateDir })).resolves.toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain(`${sessionId}: on`);

    await expect(runDaemonSessionDebugLogCommand(['off', sessionId], { daemonStateDir })).resolves.toBe(0);
    expect((await spawnEnvFor(sessionId)).HAPPIER_LOG_LEVEL).toBeUndefined();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runDaemonSessionDebugLogCommand(['maybe', sessionId], { daemonStateDir })).resolves.toBe(1);
    await expect(runDaemonSessionDebugLogCommand(['on'], { daemonStateDir })).resolves.toBe(1);
    expect(error).toHaveBeenCalled();
  });

  describe('at spawn, a switch that cannot be read is off and never fails the spawn', () => {
    async function spawnEnvAtSpawn(params: Readonly<{
      sessionId: string;
      resolveDaemonStateDir: () => string;
    }>): Promise<Readonly<{ env: NodeJS.ProcessEnv; warn: ReturnType<typeof vi.fn> }>> {
      const warn = vi.fn();
      const debugLogEnv = await resolveSessionRunnerDebugLogEnvForSpawn({ ...params, warn });
      const env = buildSpawnChildProcessEnv({ processEnv: { PATH: '/bin' }, extraEnv: { CUSTOM: 'x', ...debugLogEnv } });
      return { env, warn };
    }

    it('spawns at the default level, warning once with the error, when locating the switch throws', async () => {
      // The daemon derives the directory from its configuration; dirname() of a missing value throws.
      const { env, warn } = await spawnEnvAtSpawn({
        sessionId: 'cmthrowingread0005',
        resolveDaemonStateDir: () => dirname(undefined as unknown as string),
      });

      expect(env.HAPPIER_LOG_LEVEL).toBeUndefined();
      expect(env.CUSTOM).toBe('x');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({
        sessionId: 'cmthrowingread0005',
        error: expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      });
    });

    it('spawns at the default level, warning once with the error, when the switch directory is unreadable', async () => {
      const sessionId = 'cmunreadableswitch6';
      await writeSessionRunnerDebugLog({ daemonStateDir, sessionId, enabled: true });
      const switchDir = join(daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME);
      await chmod(switchDir, 0o000);
      try {
        const { env, warn } = await spawnEnvAtSpawn({ sessionId, resolveDaemonStateDir: () => daemonStateDir });

        expect(env.HAPPIER_LOG_LEVEL).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toEqual({ sessionId, error: expect.objectContaining({ code: 'EACCES' }) });
      } finally {
        await chmod(switchDir, 0o700);
      }
    });

    it('spawns at the default level, warning once, when the marker is not a regular file', async () => {
      const sessionId = 'cmdirectorymarker07';
      await mkdir(join(daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME, sessionId), { recursive: true });

      const { env, warn } = await spawnEnvAtSpawn({ sessionId, resolveDaemonStateDir: () => daemonStateDir });

      expect(env.HAPPIER_LOG_LEVEL).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ sessionId, error: expect.any(Error) });
    });

    it('treats a missing switch directory as off without a warning, and any regular-file marker as on', async () => {
      const missing = await spawnEnvAtSpawn({
        sessionId: 'cmmissingswitchdir8',
        resolveDaemonStateDir: () => join(daemonStateDir, 'no-such-daemon-state-dir'),
      });
      expect(missing.env.HAPPIER_LOG_LEVEL).toBeUndefined();
      expect(missing.warn).not.toHaveBeenCalled();

      // The marker's contents are informational; the switch is the marker's existence as a file.
      const sessionId = 'cmmalformedmarker09';
      await mkdir(join(daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME), { recursive: true });
      await writeFile(join(daemonStateDir, SESSION_RUNNER_DEBUG_LOG_DIRNAME, sessionId), 'not json');
      const malformed = await spawnEnvAtSpawn({ sessionId, resolveDaemonStateDir: () => daemonStateDir });
      expect(malformed.env.HAPPIER_LOG_LEVEL).toBe('debug');
      expect(malformed.warn).not.toHaveBeenCalled();
    });
  });
});
