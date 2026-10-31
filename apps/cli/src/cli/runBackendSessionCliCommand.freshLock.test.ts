import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import type { AgentState, Metadata, Session } from '@/api/types';
import { reloadConfiguration } from '@/configuration';
import { readSessionRunnerLockStatus } from '@/daemon/sessionRunnerLock';
import { isSessionRunnerActive, probeSessionRunnerServiceability, resolveSessionRunnerResumeDecision } from '@/daemon/sessions/isSessionRunnerActive';
import { writeCredentialsLegacy } from '@/persistence';
import { logger } from '@/ui/logger';
import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfiguration();
});

describe('primary Session runner ownership', () => {
  it('holds the fresh Session lock before constructing its client and releases it on startup failure', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-runner-'));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    await writeCredentialsLegacy({ token: 'test-token', secret: new Uint8Array(32) });
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('runner-exit'); });
    const sessionId = 'fresh-session-before-webhook';
    const metadata = { path: '/workspace', host: 'test', startedBy: 'daemon' } as Metadata;
    const state: AgentState = { controlledByUser: false };
    const response: Session = {
      id: sessionId, seq: 0, encryptionMode: 'plain', metadata, metadataVersion: 0,
      agentState: state, agentStateVersion: 0,
    };
    let observedLock: Awaited<ReturnType<typeof readSessionRunnerLockStatus>> | null = null;
    let clientConstructionReached = false;
    let duplicateRunnerEntered = false;
    try {
      await expect(runBackendSessionCliCommand({
        context: { args: ['codex', '--started-by', 'daemon'], rawArgv: [], terminalRuntime: null },
        loadRun: async () => async () => {
          await initializeBackendRunSession({
            api: {
              getOrCreateSession: async () => response,
              sessionSyncClient: () => {
                // This network-client boundary must not be reached without runner ownership.
                clientConstructionReached = true;
                throw new Error('client-construction-failed');
              },
            },
            sessionTag: 'fresh-tag', metadata, state, uiLogPrefix: '[Test]',
            startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
          }).catch(async (error: unknown) => {
            observedLock = await readSessionRunnerLockStatus({ happyHomeDir, sessionId });
            expect(await isSessionRunnerActive({ sessionId, trackedSessions: [] })).toBe(true);
            const probe = await probeSessionRunnerServiceability({
              sessionId, trackedSessions: [],
              probeCapability: async () => ({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' }),
            });
            expect(resolveSessionRunnerResumeDecision(probe)).toEqual({ action: 'wait_for_exit', reason: 'rpc_method_unavailable' });
            await expect(runBackendSessionCliCommand({
              context: { args: ['codex', '--started-by', 'daemon', '--existing-session', sessionId], rawArgv: [], terminalRuntime: null },
              loadRun: async () => async () => {
                duplicateRunnerEntered = true;
                throw new Error('duplicate-runner-started');
              },
            })).rejects.toThrow('runner-exit');
            // A losing activation must neither enter its runner nor release the bootstrap's lock.
            expect(await readSessionRunnerLockStatus({ happyHomeDir, sessionId })).toEqual(observedLock);
            expect(duplicateRunnerEntered).toBe(false);
            throw error;
          });
        },
      })).rejects.toThrow('runner-exit');
      expect(clientConstructionReached).toBe(true);
      expect(observedLock).toMatchObject({ ok: true, lock: { sessionId, pid: process.pid } });
      await expect(readSessionRunnerLockStatus({ happyHomeDir, sessionId })).resolves.toEqual({ ok: false, reason: 'not_found' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
