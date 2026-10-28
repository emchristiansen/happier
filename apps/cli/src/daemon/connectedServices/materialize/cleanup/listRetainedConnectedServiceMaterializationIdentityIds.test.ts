import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { V2SessionRecord } from '@happier-dev/protocol';

describe('listRetainedConnectedServiceMaterializationIdentityIds', () => {
  it.each(['archived', 'unreadable', 'page-limit', 'repeated-cursor', 'missing-cursor', 'complete'] as const)(
    'does not dispose Session history from a %s retention snapshot', async (snapshot) => {
      const home = await createTempDir('happier-session-retention-snapshot-');
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      env.patch({ HAPPIER_HOME_DIR: home });
      vi.resetModules();
      try {
        const { default: axios } = await import('axios');
        const { ConnectedServiceMaterializedHomeCleanupScheduler } = await import('./ConnectedServiceMaterializedHomeCleanupScheduler');
        const { listRetainedConnectedServiceMaterializationIdentityIds } = await import('./listRetainedConnectedServiceMaterializationIdentityIds');
        const baseDir = join(home, 'daemon', 'connected-services', 'materialized');
        const root = join(baseDir, 'csm_session_history', 'codex');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'history.jsonl'), 'private Session history\n');
        await utimes(root, new Date(1), new Date(1));
        const record: V2SessionRecord = {
          id: 'archived-session', seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 1,
          archivedAt: 2, encryptionMode: 'plain', metadataVersion: 1, agentState: null,
          agentStateVersion: 0, dataEncryptionKey: null,
          metadata: snapshot === 'unreadable' ? '{invalid' : JSON.stringify({
            connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_session_history', createdAt: 1 },
          }),
        };
        let page = 0;
        // Only the HTTP boundary is doubled. Real response parsing and metadata decoding decide
        // whether this snapshot can authorize actual filesystem disposal.
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
          const archived = new URL(String(url)).pathname.endsWith('/archived');
          page += 1;
          const incomplete = snapshot === 'page-limit' || snapshot === 'repeated-cursor' || snapshot === 'missing-cursor';
          return { status: 200, data: {
            sessions: snapshot === 'unreadable' || (snapshot === 'archived' && archived) ? [record] : [],
            hasNext: incomplete,
            nextCursor: snapshot === 'missing-cursor' ? null
              : snapshot === 'repeated-cursor' ? 'same-cursor'
                : incomplete ? `page-${page}` : null,
          } };
        });
        const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
          baseDir, nowMs: () => 40 * 24 * 60 * 60_000, hasLiveTarget: () => false,
          listRetainedIdentityIds: () => listRetainedConnectedServiceMaterializationIdentityIds({
            baseDir, credentials: { token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
          }),
        });
        if (snapshot === 'complete') {
          await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
            expect.objectContaining({ cleaned: true, path: root }),
          ]);
          await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          if (snapshot === 'archived') await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([]);
          else await expect(scheduler.reconcileMaterializedHomes()).rejects.toThrow();
          expect(await readFile(join(root, 'history.jsonl'), 'utf8')).toBe('private Session history\n');
        }
      } finally {
        vi.restoreAllMocks(); env.restore();
        await rm(home, { recursive: true, force: true });
        vi.resetModules();
      }
    },
  );

  it('keeps aged live, retained and unidentified legacy Run homes and cleans explicit disposable Runs', async () => {
    const home = await createTempDir('happier-run-retention-collector-');
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    env.patch({ HAPPIER_HOME_DIR: home });
    vi.resetModules();
    try {
      const { default: axios } = await import('axios');
      // HTTP is the system boundary. Real pagination parsing, metadata reading, marker persistence,
      // run launch parsing, identity projection and filesystem cleanup remain in the owning path.
      vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { sessions: [], nextCursor: null, hasNext: false } });
      const { writeExecutionRunMarker } = await import('@/daemon/executionRunRegistry');
      const { ConnectedServiceRuntimeRegistry } = await import('../../runtimeRegistry/registry');
      const { buildExecutionRunConnectedServicesLaunchV1 } = await import('../../runsBridge/contract');
      const { resolveConnectedServiceMaterializedRootDir } = await import('../resolveConnectedServiceMaterializedRootDir');
      const { ConnectedServiceMaterializedHomeCleanupScheduler } = await import('./ConnectedServiceMaterializedHomeCleanupScheduler');
      const { listRetainedConnectedServiceMaterializationIdentityIds } = await import('./listRetainedConnectedServiceMaterializationIdentityIds');
      const baseDir = join(home, 'daemon', 'connected-services', 'materialized');
      const paths: Record<string, string> = {};
      const registry = new ConnectedServiceRuntimeRegistry();
      const liveRunKey = 'execution_run:independent-launch-live';
      for (const kind of ['resumable', 'ephemeral', 'live'] as const) {
        const retentionPolicy = kind === 'resumable' ? 'resumable' : 'ephemeral';
        const runId = `manager-run-${kind}`;
        const runKey = `execution_run:independent-launch-${kind}`;
        const root = resolveConnectedServiceMaterializedRootDir({ baseDir, agentId: 'codex', materializationKey: runKey });
        paths[kind] = root;
        await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
        await writeFile(join(root, 'codex-home', 'sessions', 'rollout.jsonl'), 'private retained history\n');
        await utimes(root, new Date(1), new Date(1));
        await writeExecutionRunMarker({
          pid: 4321, happySessionId: 'parent-session', runId, callId: runId, sidechainId: runId,
          intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          runClass: 'long_lived', ioMode: 'request_response', retentionPolicy,
          status: kind === 'live' ? 'running' : 'cancelled', startedAtMs: 1, updatedAtMs: 2,
          ...(kind === 'live' ? {} : { finishedAtMs: 2 }),
          executionRunConnectedServicesLaunchV1: buildExecutionRunConnectedServicesLaunchV1({
            v: 1, agentId: 'codex', materializationKey: runKey,
            connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
            brokerSelectionIdentity: null, runtimeAccountIdentitySelections: [], sessionDirectory: null,
            materializedRoot: root,
          }),
        });
      }
      registry.registerRunTarget({ runKey: liveRunKey, pid: 4321, agentId: 'codex', sessionId: 'parent-session',
        materializationKey: liveRunKey, connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} } });
      // Older terminal markers omitted the independent random launch key. The existing layout
      // cannot recover that identity from manager runId; absence of a marker is not disposal proof.
      paths.unknown = resolveConnectedServiceMaterializedRootDir({
        baseDir, agentId: 'codex', materializationKey: 'execution_run:legacy-unidentified',
      });
      await mkdir(join(paths.unknown, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(join(paths.unknown, 'codex-home', 'sessions', 'rollout.jsonl'), 'unresumed legacy history\n');
      await utimes(paths.unknown, new Date(1), new Date(1));
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 40 * 24 * 60 * 60_000, hasLiveTarget: () => false,
        runtimeRegistry: registry,
        listRetainedIdentityIds: () => listRetainedConnectedServiceMaterializationIdentityIds({
          baseDir,
          credentials: { token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        }),
      });

      expect(await scheduler.reconcileMaterializedHomes()).toEqual([
        expect.objectContaining({ cleaned: true, path: paths.ephemeral }),
      ]);
      expect(await readFile(join(paths.resumable, 'codex-home', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('private retained history\n');
      expect(await readFile(join(paths.live, 'codex-home', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('private retained history\n');
      expect(await readFile(join(paths.unknown, 'codex-home', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('unresumed legacy history\n');
      await expect(stat(paths.ephemeral)).rejects.toMatchObject({ code: 'ENOENT' });
      registry.unregisterRunKey(liveRunKey);
      // Stale marker status is not liveness: once the canonical runtime target releases, its
      // explicitly ephemeral home leaves the existing pending-cleanup queue normally.
      expect(await scheduler.cleanupPendingMaterializedHomes()).toEqual([
        expect.objectContaining({ cleaned: true, path: paths.live }),
      ]);
      await expect(stat(paths.live)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      env.restore();
      await rm(home, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
