import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { waitForCondition } from '@/testkit/async/waitFor';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir } from '@/testkit/fs/tempDir';
import type { V2SessionRecord } from '@happier-dev/protocol';

const DAY_MS = 24 * 60 * 60_000;
const PROJECT = '-synthetic-project';
const RESUME_ID = '9b0b3c4e-6a7d-4f51-9e1f-3f1b2c4d5e6f';
const SECOND_RESUME_ID = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const LEGACY_HASH_ID = 'a'.repeat(64);

async function put(path: string, contents: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

async function age(path: string, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  await utimes(path, at, at);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Every synthetic transcript byte string anywhere under the disposable home. */
async function collectHistories(root: string): Promise<string[]> {
  const contents: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.jsonl(?:\.local-\d+(?:-\d+)?)?$/.test(entry.name)) contents.push(await readFile(path, 'utf8'));
    }
  };
  await walk(root);
  return contents.sort();
}

type StartupHarness = Readonly<{
  home: string;
  activeServerDir: string;
  materializedBaseDir: string;
  /** Mirrors startDaemon's startup cleanup wiring and returns once the first materialized tick settled. */
  startDaemonCleanup: (input: Readonly<{
    deletedGroups: ReadonlySet<string>;
    liveMaterializationIds: Set<string>;
    archivedSessionIdentityIds?: readonly string[];
  }>) => Promise<Readonly<{ triggerTick: () => Promise<void>; stop: () => void; errors: unknown[] }>>;
  writeEphemeralRunMarker: (runKey: string, root: string) => Promise<void>;
  syncClaude: (input: Readonly<{ targetDir: string; ambientDir: string; vendorResumeId: string; candidate: string }>) => Promise<void>;
  restore: () => Promise<void>;
}>;

async function createStartupHarness(prefix: string): Promise<StartupHarness> {
  const home = await createTempDir(prefix);
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  env.patch({ HAPPIER_HOME_DIR: home });
  vi.resetModules();
  const { default: axios } = await import('axios');
  const { configuration } = await import('@/configuration');
  const { ConnectedServiceGroupHomeCleanupScheduler } = await import('./connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler');
  const { ConnectedServiceMaterializedHomeCleanupScheduler } = await import('./connectedServices/materialize/cleanup/ConnectedServiceMaterializedHomeCleanupScheduler');
  const { startConnectedServiceMaterializedHomeCleanupLoop } = await import('./connectedServices/materialize/cleanup/startConnectedServiceMaterializedHomeCleanupLoop');
  const { listRetainedConnectedServiceMaterializationIdentityIds } = await import('./connectedServices/materialize/cleanup/listRetainedConnectedServiceMaterializationIdentityIds');
  const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
  const { writeExecutionRunMarker } = await import('./executionRunRegistry');
  const { buildExecutionRunConnectedServicesLaunchV1 } = await import('./connectedServices/runsBridge/contract');
  const { syncClaudeConnectedServiceHome } = await import('@/backends/claude/connectedServices/syncClaudeConnectedServiceHome');
  // Same base the daemon composes (startDaemon: happyHomeDir/daemon/connected-services/materialized).
  const materializedBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
  const credentials = { token: 'synthetic-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };

  return {
    home,
    activeServerDir: configuration.activeServerDir,
    materializedBaseDir,
    startDaemonCleanup: async ({ deletedGroups, liveMaterializationIds, archivedSessionIdentityIds = [] }) => {
      // HTTP is the only doubled boundary: the real retained-root listing parses these pages.
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const archived = new URL(String(url)).pathname.endsWith('/archived');
        const sessions: V2SessionRecord[] = archived ? archivedSessionIdentityIds.map((id, index) => ({
          id: `archived-${index}`, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 1, archivedAt: 2,
          encryptionMode: 'plain', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
          metadata: JSON.stringify({ connectedServiceMaterializationIdentityV1: { v: 1, id, createdAt: 1 } }),
        })) : [];
        return { status: 200, data: { sessions, hasNext: false, nextCursor: null } };
      });
      const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
      const resolveGroupDeletionAuthority = async ({ groupId }: Readonly<{ groupId: string }>) => (
        { status: deletedGroups.has(groupId) ? 'deleted' as const : 'exists' as const }
      );
      // Constructor dependencies match startDaemon: no removal/purge override is supplied there.
      const groupScheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: configuration.activeServerDir,
        runtimeRegistry,
        hasLiveTarget: () => false,
        resolveGroupDeletionAuthority,
      });
      const materializedScheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir: materializedBaseDir,
        runtimeRegistry,
        nowMs: () => Date.now(),
        rootTtlMs: 30 * DAY_MS,
        attemptsTtlMs: 60 * 60_000,
        hasLiveTarget: ({ materializationIdentityId }) => liveMaterializationIds.has(materializationIdentityId),
        listRetainedIdentityIds: async () =>
          await listRetainedConnectedServiceMaterializationIdentityIds({ credentials, baseDir: materializedBaseDir }),
      });
      let ticks = 0;
      const errors: unknown[] = [];
      const loop = startConnectedServiceMaterializedHomeCleanupLoop({
        enabled: true,
        tickMs: 30 * 60_000,
        scheduler: {
          cleanupPendingMaterializedHomes: async () => await materializedScheduler.cleanupPendingMaterializedHomes(),
          reconcileMaterializedHomes: async () => {
            try { return await materializedScheduler.reconcileMaterializedHomes(); } finally { ticks += 1; }
          },
        },
        onTickError: (error) => { errors.push(error); ticks += 1; },
      });
      const triggerTick = async () => {
        const target = ticks + 1;
        loop?.trigger();
        await waitForCondition(() => ticks >= target, { timeoutMs: 10_000, intervalMs: 10, label: 'materialized cleanup tick' });
      };
      // startDaemon: group reconciliation, then the materialized loop trigger, after passive reattach.
      await groupScheduler.reconcileDeletedGroupHomes({ resolveGroupDeletionAuthority });
      await triggerTick();
      return { triggerTick, stop: () => loop?.stop(), errors };
    },
    writeEphemeralRunMarker: async (runKey, root) => {
      await writeExecutionRunMarker({
        pid: 4321, happySessionId: 'parent-session', runId: 'manager-run', callId: 'manager-run', sidechainId: 'manager-run',
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        runClass: 'long_lived', ioMode: 'request_response', retentionPolicy: 'ephemeral',
        status: 'cancelled', startedAtMs: 1, updatedAtMs: 2, finishedAtMs: 2,
        executionRunConnectedServicesLaunchV1: buildExecutionRunConnectedServicesLaunchV1({
          v: 1, agentId: 'codex', materializationKey: runKey,
          connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
          brokerSelectionIdentity: null, runtimeAccountIdentitySelections: [], sessionDirectory: null,
          materializedRoot: root,
        }),
      });
    },
    syncClaude: async ({ targetDir, ambientDir, vendorResumeId, candidate }) => {
      await syncClaudeConnectedServiceHome({
        sourceEnv: { HOME: home, CLAUDE_CONFIG_DIR: targetDir },
        targetDir,
        sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
        ambientStateSourceDir: ambientDir,
        vendorResumeId,
        candidatePersistedSessionFile: candidate,
      });
    },
    restore: async () => {
      vi.restoreAllMocks();
      env.restore();
      await rm(home, { recursive: true, force: true });
      vi.resetModules();
    },
  };
}

describe('startDaemon connected-service history retention wiring', () => {
  it('retires adopted Run credentials instead of deleting the Run root and supplies no deletion hooks', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf('createAdoptedRootCleanup:');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf('});', start));
    expect(block).toContain('createAdoptedExecutionRunRootCleanup({');
    expect(block).toMatch(/retireRoot: async \(rootDir\) => await deleteConnectedServiceHomeCredentials\(\{ rootDir, agentId, kind: 'materialized_home' \}\)/);
    expect(block).not.toMatch(/\brm\(/);
    // The cleanup schedulers keep their retaining defaults; startDaemon never injects a deleter.
    expect(source).not.toMatch(/\b(?:removePath|purgePath|removeRoot):/);
  });
});

describe('daemon startup cleanup over a disposable daemon home', () => {
  it('retains materialized, attempt, pending, group and quarantine histories while revoking only intended credentials', async () => {
    const h = await createStartupHarness('happier-startup-history-retention-');
    try {
      const m = h.materializedBaseDir;
      const groups = join(h.activeServerDir, 'daemon', 'connected-services', 'homes');
      // Stale unreferenced Claude home with a canonical transcript and a conflicting import copy.
      const staleClaude = join(m, 'csm_stale_claude', 'claude');
      await put(join(staleClaude, 'claude-config', 'projects', PROJECT, `${RESUME_ID}.jsonl`), 'stale claude canonical\n');
      await put(join(staleClaude, 'claude-config', 'projects', PROJECT, `${RESUME_ID}.happier-import-0011aabbccdd.jsonl`), 'stale claude conflicting copy\n');
      await put(join(staleClaude, 'claude-config', '.credentials.json'), 'synthetic stale claude credential');
      await age(staleClaude, 40 * DAY_MS);
      // Archived Session reference, explicit ephemeral Run, unidentified legacy hash root, fresh root.
      const archived = join(m, 'csm_archived_ref', 'codex');
      const ephemeralKey = 'execution_run:synthetic-ephemeral';
      const { normalizeMaterializationKeyForPath } = await import('./connectedServices/materialize/normalizeMaterializationKeyForPath');
      const ephemeral = join(m, normalizeMaterializationKeyForPath(ephemeralKey), 'codex');
      const legacy = join(m, LEGACY_HASH_ID, 'codex');
      const fresh = join(m, 'csm_fresh', 'pi');
      const live = join(m, 'csm_live', 'codex');
      for (const [root, label] of [[archived, 'archived'], [ephemeral, 'ephemeral'], [legacy, 'legacy'], [live, 'live']] as const) {
        await put(join(root, 'codex-home', 'sessions', 'rollout.jsonl'), `${label} codex history\n`);
        await put(join(root, 'codex-home', 'auth.json'), `synthetic ${label} credential`);
        await age(root, 40 * DAY_MS);
      }
      await put(join(fresh, 'pi-agent-dir', 'sessions', 'p', 'session.jsonl'), 'fresh pi history\n');
      await put(join(fresh, 'pi-agent-dir', 'auth.json'), 'synthetic fresh credential');
      await h.writeEphemeralRunMarker(ephemeralKey, ephemeral);
      // Stale attempt root.
      const attempt = join(m, '.attempts', 'csm_attempt-codex-6f9b2d0c');
      await put(join(attempt, 'codex-home', 'sessions', 'attempt.jsonl'), 'attempt codex history\n');
      await put(join(attempt, 'codex-home', 'auth.json'), 'synthetic attempt credential');
      await age(attempt, 2 * 60 * 60_000);
      // Deleted group home, a live group home, and an already-expired quarantine entry.
      const deletedGroup = join(groups, 'claude-subscription', '__groups', 'deleted-pool', 'claude');
      await put(join(deletedGroup, 'claude-config', 'projects', PROJECT, 'group.jsonl'), 'deleted group history\n');
      await put(join(deletedGroup, 'claude-config', '.credentials.json'), 'synthetic deleted group credential');
      const liveGroup = join(groups, 'claude-subscription', '__groups', 'live-pool', 'claude');
      await put(join(liveGroup, 'claude-config', 'projects', PROJECT, 'live-group.jsonl'), 'live group history\n');
      await put(join(liveGroup, 'claude-config', '.credentials.json'), 'synthetic live group credential');
      const expiredQuarantine = join(groups, 'openai-codex', '__groups', 'old-pool', '.quarantine', `${Date.now() - 30 * DAY_MS}-codex`);
      await put(join(expiredQuarantine, 'codex-home', 'sessions', 'quarantined.jsonl'), 'expired quarantine history\n');
      await put(join(expiredQuarantine, 'codex-home', 'auth.json'), 'synthetic quarantined credential');
      const before = await collectHistories(h.home);
      expect(before).toHaveLength(11);

      const liveIds = new Set(['csm_live']);
      const startup = await h.startDaemonCleanup({
        deletedGroups: new Set(['deleted-pool']), liveMaterializationIds: liveIds, archivedSessionIdentityIds: ['csm_archived_ref'],
      });
      try {
        expect(startup.errors).toEqual([]);
        // Revoked: unreferenced stale home, explicit ephemeral Run, stale attempt, deleted group, expired quarantine.
        for (const credential of [
          join(staleClaude, 'claude-config', '.credentials.json'), join(ephemeral, 'codex-home', 'auth.json'),
          join(attempt, 'codex-home', 'auth.json'), join(expiredQuarantine, 'codex-home', 'auth.json'),
        ]) await expect(exists(credential), relative(h.home, credential)).resolves.toBe(false);
        const quarantine = join(dirname(deletedGroup), '.quarantine');
        const [quarantined] = await readdir(quarantine);
        expect(await exists(join(quarantine, quarantined, 'claude-config', '.credentials.json'))).toBe(false);
        // Kept: Session-referenced, legacy, fresh, live (pending) and existing-group credentials.
        for (const [credential, contents] of [
          [join(archived, 'codex-home', 'auth.json'), 'synthetic archived credential'],
          [join(legacy, 'codex-home', 'auth.json'), 'synthetic legacy credential'],
          [join(fresh, 'pi-agent-dir', 'auth.json'), 'synthetic fresh credential'],
          [join(live, 'codex-home', 'auth.json'), 'synthetic live credential'],
          [join(liveGroup, 'claude-config', '.credentials.json'), 'synthetic live group credential'],
        ] as const) expect(await readFile(credential, 'utf8'), relative(h.home, credential)).toBe(contents);

        // The live owner exits; the next tick drains its pending cleanup.
        liveIds.clear();
        await startup.triggerTick();
        expect(startup.errors).toEqual([]);
        expect(await exists(join(live, 'codex-home', 'auth.json'))).toBe(false);
        // A daemon restart (fresh schedulers) does not expire anything retained above.
        startup.stop();
        const restarted = await h.startDaemonCleanup({ deletedGroups: new Set(['deleted-pool']), liveMaterializationIds: new Set() });
        restarted.stop();
        expect(restarted.errors).toEqual([]);
        expect(await collectHistories(h.home)).toEqual(before);
      } finally {
        startup.stop();
      }
    } finally {
      await h.restore();
    }
  });

  it('upgrades a home left by 0.2.12 without losing any history at the first startup and Claude sync', async () => {
    const h = await createStartupHarness('happier-upgrade-history-retention-');
    try {
      const m = h.materializedBaseDir;
      const groups = join(h.activeServerDir, 'daemon', 'connected-services', 'homes');
      // 0.2.12 leaves roots it has not yet reaped (younger than its 30-day / 1-hour / 7-day sweeps)
      // with their credentials in place; by the first new startup they have crossed those ages.
      const pEraHome = join(m, 'csm_p_era', 'claude');
      await put(join(pEraHome, 'claude-config', 'projects', PROJECT, 'p-era.jsonl'), 'p-era materialized history\n');
      await put(join(pEraHome, 'claude-config', '.credentials.json'), 'synthetic p-era credential');
      await put(join(pEraHome, 'claude-config', '.claude.json'), '{"synthetic":true}');
      await age(pEraHome, 31 * DAY_MS);
      const pLegacy = join(m, LEGACY_HASH_ID, 'codex');
      await put(join(pLegacy, 'codex-home', 'sessions', 'legacy.jsonl'), 'p-era legacy run history\n');
      await put(join(pLegacy, 'codex-home', 'auth.json'), 'synthetic p-era legacy credential');
      await age(pLegacy, 90 * DAY_MS);
      const pAttempt = join(m, '.attempts', 'csm_p_era-codex-1d2e3f4a');
      await put(join(pAttempt, 'codex-home', 'sessions', 'attempt.jsonl'), 'p-era attempt history\n');
      await put(join(pAttempt, 'codex-home', 'auth.json'), 'synthetic p-era attempt credential');
      await age(pAttempt, 2 * 60 * 60_000);
      const quarantineRoot = join(groups, 'claude-subscription', '__groups', 'p-deleted', '.quarantine');
      const expired = join(quarantineRoot, `${Date.now() - 8 * DAY_MS}-claude`);
      await put(join(expired, 'claude-config', 'projects', PROJECT, 'quarantined.jsonl'), 'p-era expired quarantine history\n');
      await put(join(expired, 'claude-config', '.credentials.json'), 'synthetic p-era quarantined credential');
      const young = join(quarantineRoot, `${Date.now() - DAY_MS}-claude`);
      await put(join(young, 'claude-config', 'projects', PROJECT, 'young.jsonl'), 'p-era young quarantine history\n');
      await put(join(young, 'claude-config', '.credentials.json'), 'synthetic p-era young credential');
      // A 0.2.12 Claude profile home in shared state with leftover conflicting import copies.
      const profileTarget = join(groups, 'claude-subscription', 'p-profile', 'claude', 'claude-config');
      const nativeDir = join(h.home, 'native-claude');
      const nativeProject = join(nativeDir, 'projects', PROJECT);
      await mkdir(profileTarget, { recursive: true });
      const canonical = await put(join(nativeProject, `${RESUME_ID}.jsonl`), 'p-era canonical newest\n');
      const staleCopy = await put(join(nativeProject, `${RESUME_ID}.happier-import-00aa11bb22cc.jsonl`), 'p-era stale conflicting copy\n');
      await age(staleCopy, 2 * 60 * 60_000);
      const olderCanonical = await put(join(nativeProject, `${SECOND_RESUME_ID}.jsonl`), 'p-era older canonical\n');
      await age(olderCanonical, 3 * 60 * 60_000);
      await put(join(nativeProject, `${SECOND_RESUME_ID}.happier-import-33dd44ee55ff.jsonl`), 'p-era newer conflicting copy\n');
      const candidates = join(h.home, 'previous-claude', 'projects', PROJECT);
      const firstCandidate = await put(join(candidates, `${RESUME_ID}.jsonl`), 'p-era older candidate\n');
      await age(firstCandidate, 60 * 60_000);
      const secondCandidate = await put(join(candidates, `${SECOND_RESUME_ID}.jsonl`), 'p-era oldest candidate\n');
      await age(secondCandidate, 4 * 60 * 60_000);
      await age(canonical, 0);
      const { symlink } = await import('node:fs/promises');
      await symlink(join(nativeDir, 'projects'), join(profileTarget, 'projects'), 'dir');
      const before = await collectHistories(h.home);

      const startup = await h.startDaemonCleanup({ deletedGroups: new Set(), liveMaterializationIds: new Set() });
      startup.stop();
      expect(startup.errors).toEqual([]);
      // First spawn after upgrade synchronizes the Claude home for both resumed conversations.
      await h.syncClaude({ targetDir: profileTarget, ambientDir: nativeDir, vendorResumeId: RESUME_ID, candidate: firstCandidate });
      await h.syncClaude({ targetDir: profileTarget, ambientDir: nativeDir, vendorResumeId: SECOND_RESUME_ID, candidate: secondCandidate });

      const after = await collectHistories(h.home);
      for (const history of before) expect(after, history).toContain(history);
      // Resume selection is unchanged: the newest content owns the canonical filename.
      expect(await readFile(canonical, 'utf8')).toBe('p-era canonical newest\n');
      expect(await readFile(join(nativeProject, `${SECOND_RESUME_ID}.jsonl`), 'utf8')).toBe('p-era newer conflicting copy\n');
      // Credentials: expired 0.2.12 leftovers are revoked; unexpired quarantine and legacy roots keep theirs.
      for (const credential of [
        join(pEraHome, 'claude-config', '.credentials.json'), join(pEraHome, 'claude-config', '.claude.json'),
        join(pAttempt, 'codex-home', 'auth.json'), join(expired, 'claude-config', '.credentials.json'),
      ]) await expect(exists(credential), relative(h.home, credential)).resolves.toBe(false);
      expect(await readFile(join(young, 'claude-config', '.credentials.json'), 'utf8')).toBe('synthetic p-era young credential');
      expect(await readFile(join(pLegacy, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic p-era legacy credential');
    } finally {
      await h.restore();
    }
  });
});
