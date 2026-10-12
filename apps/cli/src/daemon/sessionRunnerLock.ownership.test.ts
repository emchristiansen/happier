import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import {
  acquireSessionRunnerLock,
  claimSessionRunnerOwnership,
  readSessionRunnerLockStatus,
  withSessionRunnerOwnership,
} from './sessionRunnerLock';

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
});

describe('primary runner ownership lifetime', () => {
  it('lets the offline retry owner claim after a previous holder exits and shares simultaneous claims', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-retry-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    const sessionId = 'reconnected-session';
    const previous = await acquireSessionRunnerLock({ sessionId });
    if (!previous.ok) throw new Error('Unable to establish the previous runner');
    try {
      await withSessionRunnerOwnership(async () => {
        await expect(claimSessionRunnerOwnership(sessionId)).rejects.toThrow('already running');
        await previous.release();
        await Promise.all([claimSessionRunnerOwnership(sessionId), claimSessionRunnerOwnership(sessionId)]);
        await expect(readSessionRunnerLockStatus({ sessionId })).resolves.toMatchObject({
          ok: true, lock: { sessionId, pid: process.pid },
        });
      });
      await expect(readSessionRunnerLockStatus({ sessionId })).resolves.toEqual({ ok: false, reason: 'not_found' });
    } finally {
      await previous.release();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('leaves non-runner API consumers inert', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-non-runner-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    try {
      await claimSessionRunnerOwnership('api-consumer-session');
      await expect(readSessionRunnerLockStatus({ sessionId: 'api-consumer-session' })).resolves.toEqual({
        ok: false, reason: 'not_found',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('rejects an unfinished background claim when the primary runner has already ended', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-ended-runner-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    let backgroundClaim: Promise<void> = Promise.resolve();
    try {
      await withSessionRunnerOwnership(async () => {
        backgroundClaim = claimSessionRunnerOwnership('late-background-session');
        void backgroundClaim.catch(() => {});
      });
      await expect(backgroundClaim).rejects.toThrow('scope has ended');
      await expect(readSessionRunnerLockStatus({ sessionId: 'late-background-session' })).resolves.toEqual({
        ok: false, reason: 'not_found',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
