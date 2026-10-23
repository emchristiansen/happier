import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import {
  readSessionRunnerDebugLog,
  resolveSessionRunnerDebugLogEnv,
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
});
