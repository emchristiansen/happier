import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, createTempDirSync } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { V2SessionRecord } from '@happier-dev/protocol';

// The real modules construct the process-global Configuration on first evaluation, which creates
// directories and tightens permissions under HAPPIER_HOME_DIR. Evaluate them once, during file
// collection, under a home this file owns: collection is not abandoned by a case or hook timeout,
// and no case starts before it settles. Cases never reset modules or import again, so a late
// continuation cannot evaluate them under another lifetime's home.
const fileEnv = createEnvKeyScope(['HAPPIER_HOME_DIR']);
const fileHome = createTempDirSync('happier-retention-collector-home-');
fileEnv.patch({ HAPPIER_HOME_DIR: fileHome });

async function loadModulesUnderFileHome() {
  try {
    // Sequential: a rejected import has settled, and no later one has started, before the home
    // is released.
    const { default: axios } = await import('axios');
    const { writeExecutionRunMarker } = await import('@/daemon/executionRunRegistry');
    const { ConnectedServiceRuntimeRegistry } = await import('../../runtimeRegistry/registry');
    const { buildExecutionRunConnectedServicesLaunchV1 } = await import('../../runsBridge/contract');
    const { resolveConnectedServiceMaterializedRootDir } = await import('../resolveConnectedServiceMaterializedRootDir');
    const { ConnectedServiceMaterializedHomeCleanupScheduler } = await import('./ConnectedServiceMaterializedHomeCleanupScheduler');
    const { listRetainedConnectedServiceMaterializationIdentityIds } = await import('./listRetainedConnectedServiceMaterializationIdentityIds');
    // The scheduler loads the provider credential lifecycle lazily; settle that load here as well.
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    await resolveConnectedServiceCredentialLifecycleDescriptor('codex');
    return {
      axios, writeExecutionRunMarker, ConnectedServiceRuntimeRegistry, buildExecutionRunConnectedServicesLaunchV1,
      resolveConnectedServiceMaterializedRootDir, ConnectedServiceMaterializedHomeCleanupScheduler,
      listRetainedConnectedServiceMaterializationIdentityIds,
    };
  } catch (error) {
    fileEnv.restore();
    rmSync(fileHome, { recursive: true, force: true });
    throw error;
  }
}

const {
  axios, writeExecutionRunMarker, ConnectedServiceRuntimeRegistry, buildExecutionRunConnectedServicesLaunchV1,
  resolveConnectedServiceMaterializedRootDir, ConnectedServiceMaterializedHomeCleanupScheduler,
  listRetainedConnectedServiceMaterializationIdentityIds,
} = await loadModulesUnderFileHome();

describe('listRetainedConnectedServiceMaterializationIdentityIds', () => {
  // A timed-out case or hook is not cancelled: its body keeps running beside the next lifetime.
  // Each case owns only its own directory. The shared axios double is released at the runner's
  // per-case boundary, never by a late body, and every shared effect after an await first rechecks
  // the case lifetime. The environment is restored at the runner's own afterAll boundary.
  const caseBodies = new Set<Promise<void>>();
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    fileEnv.restore();
    // A late case body can still create marker directories under the file home; remove it only
    // after every body has settled, so a late body never recreates it.
    await Promise.all(caseBodies);
    await rm(fileHome, { recursive: true, force: true });
  });

  it.for(['archived', 'unreadable', 'page-limit', 'repeated-cursor', 'missing-cursor', 'complete'] as const)(
    'does not dispose Session history from a %s retention snapshot', async (snapshot, { signal }) => {
      const home = await createTempDir('happier-session-retention-snapshot-');
      let settleCaseBody!: () => void;
      caseBodies.add(new Promise<void>((resolve) => { settleCaseBody = resolve; }));
      try {
        const baseDir = join(home, 'daemon', 'connected-services', 'materialized');
        const token = `synthetic-token-${snapshot}`;
        const root = join(baseDir, 'csm_session_history', 'codex');
        await mkdir(join(root, 'codex-home'), { recursive: true });
        await writeFile(join(root, 'history.jsonl'), 'private Session history\n');
        await writeFile(join(root, 'codex-home', 'auth.json'), 'synthetic Session credential');
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
        // whether this snapshot can authorize actual filesystem disposal. A case that lost its
        // lifetime installs nothing, and a double serves only its own case's credential.
        signal.throwIfAborted();
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
          if (config?.headers?.Authorization !== `Bearer ${token}`) {
            throw new Error(`axios.get double for the ${snapshot} case received another case's request`);
          }
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
            baseDir, credentials: { token, encryption: { type: 'legacy', secret: new Uint8Array(32) } },
          }),
        });
        if (snapshot === 'complete') {
          await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
            expect.objectContaining({ cleaned: true, path: root }),
          ]);
          // A complete unreferenced snapshot authorizes credential revocation, never history disposal.
          await expect(stat(join(root, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          if (snapshot === 'archived') await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([]);
          else await expect(scheduler.reconcileMaterializedHomes()).rejects.toThrow();
          expect(await readFile(join(root, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic Session credential');
        }
        expect(await readFile(join(root, 'history.jsonl'), 'utf8')).toBe('private Session history\n');
      } finally {
        await rm(home, { recursive: true, force: true });
        settleCaseBody();
      }
    },
  );

  it('keeps aged live, retained and unidentified legacy Run homes and retires only explicit disposable Run credentials', async ({ signal }) => {
    const home = await createTempDir('happier-run-retention-collector-');
    let settleCaseBody!: () => void;
    caseBodies.add(new Promise<void>((resolve) => { settleCaseBody = resolve; }));
    try {
      // HTTP is the system boundary. Real pagination parsing, metadata reading, marker persistence,
      // run launch parsing, identity projection and filesystem cleanup remain in the owning path.
      signal.throwIfAborted();
      vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { sessions: [], nextCursor: null, hasNext: false } });
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
        await writeFile(join(root, 'codex-home', 'auth.json'), `synthetic ${kind} Run credential`);
        await utimes(root, new Date(1), new Date(1));
        // Markers live under the file-owned home; a case that lost its lifetime writes no further entry.
        signal.throwIfAborted();
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
      await writeFile(join(paths.unknown, 'codex-home', 'auth.json'), 'synthetic unknown Run credential');
      await utimes(paths.unknown, new Date(1), new Date(1));
      signal.throwIfAborted();
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
      expect(await readFile(join(paths.ephemeral, 'codex-home', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('private retained history\n');
      await expect(stat(join(paths.ephemeral, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(paths.resumable, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic resumable Run credential');
      expect(await readFile(join(paths.unknown, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic unknown Run credential');
      expect(await readFile(join(paths.live, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic live Run credential');
      signal.throwIfAborted();
      registry.unregisterRunKey(liveRunKey);
      // Stale marker status is not liveness: once the canonical runtime target releases, its
      // explicitly ephemeral home leaves the existing pending-cleanup queue normally.
      expect(await scheduler.cleanupPendingMaterializedHomes()).toEqual([
        expect.objectContaining({ cleaned: true, path: paths.live }),
      ]);
      expect(await readFile(join(paths.live, 'codex-home', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('private retained history\n');
      await expect(stat(join(paths.live, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(home, { recursive: true, force: true });
      settleCaseBody();
    }
  });
});
