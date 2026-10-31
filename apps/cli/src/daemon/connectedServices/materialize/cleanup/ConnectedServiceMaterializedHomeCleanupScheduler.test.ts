import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { buildDefaultConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from './ConnectedServiceMaterializedHomeCleanupScheduler';

async function touchOld(path: string, nowMs: number, ageMs: number): Promise<void> {
  const time = new Date(nowMs - ageMs);
  await utimes(path, time, time);
}

describe('ConnectedServiceMaterializedHomeCleanupScheduler', () => {
  it.each([
    ['claude', 'claude-config/projects/project/session.jsonl', 'claude-config/.credentials.json'],
    ['codex', 'codex-home/sessions/2020/01/01/session.jsonl', 'codex-home/auth.json'],
    ['gemini', 'home/.gemini/tmp/project/chats/session.json', 'home/.gemini/oauth_creds.json'],
    ['pi', 'pi-agent-dir/sessions/project/session.jsonl', 'pi-agent-dir/auth.json'],
    ['agy', 'gemini-home/antigravity-acp/conversations/session.json', 'gemini-home/antigravity-acp/acp_token.json'],
  ] as const)('retains ancient unreferenced %s history while revoking its file credentials', async (agentId, historyEntry, credentialEntry) => {
    const baseDir = await createTempDir('happier-retained-provider-history-');
    try {
      const home = join(baseDir, 'csm_unreferenced', agentId);
      const historyPath = join(home, historyEntry);
      const credentialPath = join(home, credentialEntry);
      await mkdir(join(historyPath, '..'), { recursive: true });
      await mkdir(join(credentialPath, '..'), { recursive: true });
      await writeFile(historyPath, 'distinct synthetic ancient history\n');
      await writeFile(credentialPath, 'synthetic credential projection');
      await touchOld(home, 100_000, 60_000);
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 100_000, rootTtlMs: 10_000,
        hasLiveTarget: () => false, listRetainedIdentityIds: () => [],
      });

      await scheduler.reconcileMaterializedHomes();

      await expect(readFile(historyPath, 'utf8')).resolves.toBe('distinct synthetic ancient history\n');
      await expect(stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
      // A new scheduler after restart must not expire the retained bytes either.
      await new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 200_000, rootTtlMs: 10_000,
        hasLiveTarget: () => false, listRetainedIdentityIds: () => [],
      }).reconcileMaterializedHomes();
      await expect(readFile(historyPath, 'utf8')).resolves.toBe('distinct synthetic ancient history\n');
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it.each([
    ['codex', 'codex-home/auth.json'],
    ['gemini', 'home/.gemini/oauth_creds.json'],
    ['agy', 'gemini-home/antigravity-acp/settings.json'],
    ['claude', 'claude-config/accounts'],
  ] as const)('refuses a directory at the %s credential leaf without deleting its history', async (agentId, credentialEntry) => {
    const baseDir = await createTempDir('happier-wrong-type-credential-');
    try {
      const home = join(baseDir, 'csm_unreferenced', agentId);
      const credentialDirectory = join(home, credentialEntry);
      await mkdir(credentialDirectory, { recursive: true });
      await writeFile(join(credentialDirectory, 'history.jsonl'), 'unexpected directory history\n');
      await touchOld(home, 100_000, 60_000);
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 100_000, rootTtlMs: 10_000, hasLiveTarget: () => false,
      });
      const outcome = await scheduler.reconcileMaterializedHomes().then(() => null, (error: unknown) => error);
      expect(await readFile(join(credentialDirectory, 'history.jsonl'), 'utf8')).toBe('unexpected directory history\n');
      expect(outcome).toBeInstanceOf(Error);
    } finally { await removeTempDir(baseDir); }
  });

  it('does not revoke credentials through a linked provider home', async () => {
    const root = await createTempDir('happier-linked-credential-custody-');
    try {
      const baseDir = join(root, 'materialized');
      const home = join(baseDir, 'csm_unreferenced', 'codex');
      const other = join(root, 'another-owned-home');
      await mkdir(other, { recursive: true });
      await writeFile(join(other, 'auth.json'), 'synthetic other binding credential');
      await writeFile(join(other, 'history.jsonl'), 'other binding history\n');
      await mkdir(home, { recursive: true });
      await symlink(other, join(home, 'codex-home'), 'dir');
      await touchOld(home, 100_000, 60_000);
      await new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 100_000, rootTtlMs: 10_000, hasLiveTarget: () => false,
      }).reconcileMaterializedHomes();
      expect(await readFile(join(other, 'auth.json'), 'utf8')).toBe('synthetic other binding credential');
      expect(await readFile(join(other, 'history.jsonl'), 'utf8')).toBe('other binding history\n');
    } finally { await removeTempDir(root); }
  });

  it('retains history when queued cleanup drains after its live owner exits', async () => {
    const baseDir = await createTempDir('happier-retained-pending-history-');
    try {
      const home = join(baseDir, 'csm_queued', 'codex');
      const historyPath = join(home, 'codex-home', 'archived_sessions', 'session.jsonl');
      const credentialPath = join(home, 'codex-home', 'auth.json');
      await mkdir(join(historyPath, '..'), { recursive: true });
      await writeFile(historyPath, 'distinct archived synthetic history\n');
      await writeFile(credentialPath, 'synthetic credential projection');
      await touchOld(home, 100_000, 60_000);
      let live = true;
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, nowMs: () => 100_000, rootTtlMs: 10_000,
        hasLiveTarget: () => live, listRetainedIdentityIds: () => [],
      });
      await scheduler.reconcileMaterializedHomes();
      await expect(readFile(credentialPath, 'utf8')).resolves.toBe('synthetic credential projection');
      live = false;
      await scheduler.cleanupPendingMaterializedHomes();
      await expect(readFile(historyPath, 'utf8')).resolves.toBe('distinct archived synthetic history\n');
      await expect(stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('keeps live and resumable materialized homes while retiring stale orphan credentials', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-cleanup-');
    const nowMs = 100_000;
    try {
      const liveHome = join(baseDir, 'csm_live', 'codex');
      const retainedHome = join(baseDir, 'csm_retained', 'claude');
      const recentHome = join(baseDir, 'csm_recent', 'pi');
      const orphanHome = join(baseDir, 'csm_orphan', 'opencode');
      await mkdir(liveHome, { recursive: true });
      await mkdir(retainedHome, { recursive: true });
      await mkdir(recentHome, { recursive: true });
      await mkdir(orphanHome, { recursive: true });
      await touchOld(liveHome, nowMs, 60_000);
      await touchOld(retainedHome, nowMs, 60_000);
      await touchOld(recentHome, nowMs, 1_000);
      await touchOld(orphanHome, nowMs, 60_000);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: ({ materializationIdentityId }) => materializationIdentityId === 'csm_live',
        listRetainedIdentityIds: async () => new Set(['csm_retained']),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: orphanHome }),
      ]);
      await expect(stat(liveHome)).resolves.toBeTruthy();
      await expect(stat(retainedHome)).resolves.toBeTruthy();
      await expect(stat(recentHome)).resolves.toBeTruthy();
      await expect(stat(orphanHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('retires stale attempt credentials only when no active materialization references them', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-attempt-cleanup-');
    const nowMs = 100_000;
    try {
      const attemptsDir = join(baseDir, '.attempts');
      const liveAttempt = join(attemptsDir, 'csm_live-codex-00000000-0000-4000-8000-000000000001');
      const staleAttempt = join(attemptsDir, 'csm_orphan-codex-00000000-0000-4000-8000-000000000002');
      await mkdir(liveAttempt, { recursive: true });
      await mkdir(staleAttempt, { recursive: true });
      await touchOld(liveAttempt, nowMs, 60_000);
      await touchOld(staleAttempt, nowMs, 60_000);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: ({ materializationIdentityId }) => materializationIdentityId === 'csm_live',
        listRetainedIdentityIds: async () => new Set(),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: staleAttempt }),
      ]);
      await expect(stat(liveAttempt)).resolves.toBeTruthy();
      await expect(stat(staleAttempt)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('deletes stale Claude keychain credentials for retained materialized homes and attempts', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-claude-keychain-cleanup-');
    const nowMs = 100_000;
    try {
      const orphanHome = join(baseDir, 'csm_orphan', 'claude');
      const staleAttempt = join(baseDir, '.attempts', 'csm_orphan-claude-00000000-0000-4000-8000-000000000001');
      const codexHome = join(baseDir, 'csm_codex', 'codex');
      await mkdir(join(orphanHome, 'claude-config'), { recursive: true });
      await mkdir(join(staleAttempt, 'claude-config'), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await touchOld(orphanHome, nowMs, 60_000);
      await touchOld(staleAttempt, nowMs, 60_000);
      await touchOld(codexHome, nowMs, 60_000);
      const deletedClaudeConfigDirs: string[] = [];

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => false,
        listRetainedIdentityIds: async () => new Set(),
        resolveCredentialLifecycleDescriptor: async (agentId) => ({
          ...buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId),
          ...(agentId === 'claude'
            ? {
                credentialStorageCleanup: {
                  async deleteCredentialStorageForHomeRoot({ rootDir }) {
                    deletedClaudeConfigDirs.push(join(rootDir, 'claude-config'));
                  },
                },
              }
            : {}),
        }),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ cleaned: true, path: orphanHome }),
        expect.objectContaining({ cleaned: true, path: staleAttempt }),
        expect.objectContaining({ cleaned: true, path: codexHome }),
      ]));
      expect(deletedClaudeConfigDirs).toEqual([
        join(orphanHome, 'claude-config'),
        join(staleAttempt, 'claude-config'),
      ]);
      await expect(stat(orphanHome)).resolves.toBeTruthy();
      await expect(stat(staleAttempt)).resolves.toBeTruthy();
      await expect(stat(codexHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('keeps a queued pending home when its identity becomes retained before child-exit cleanup', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-retained-pending-');
    const nowMs = 100_000;
    try {
      const queuedHome = join(baseDir, 'csm_later_retained', 'codex');
      await mkdir(queuedHome, { recursive: true });
      await touchOld(queuedHome, nowMs, 60_000);

      let live = true;
      const retainedIdentityIds = new Set<string>();
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => live,
        listRetainedIdentityIds: async () => retainedIdentityIds,
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([]);

      live = false;
      retainedIdentityIds.add('csm_later_retained');

      await expect(scheduler.cleanupPendingMaterializedHomes()).resolves.toEqual([]);
      await expect(stat(queuedHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('keeps failed cleanup targets retryable and drops them after the retry budget', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-cleanup-retry-');
    const nowMs = 100_000;
    try {
      const orphanHome = join(baseDir, 'csm_orphan', 'codex');
      await mkdir(orphanHome, { recursive: true });
      await touchOld(orphanHome, nowMs, 60_000);
      let removeAttempts = 0;
      const removePath: typeof rm = async () => {
        removeAttempts += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      };
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        maxCleanupRetries: 2,
        resolveCredentialLifecycleDescriptor: async (agentId) => ({
          ...buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId),
          credentialStorageCleanup: { deleteCredentialStorageForHomeRoot: async () => { await removePath('synthetic'); } },
        }),
        onCleanupRetryExhausted: ({ path, attempts, error }) => {
          terminalDiagnostics.push({ path, attempts, error });
        },
        hasLiveTarget: () => false,
        listRetainedIdentityIds: async () => new Set(),
      });
      const terminalDiagnostics: Array<Readonly<{ path: string; attempts: number; error: unknown }>> = [];

      await expect(scheduler.reconcileMaterializedHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.cleanupPendingMaterializedHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.cleanupPendingMaterializedHomes()).resolves.toEqual([]);
      expect(removeAttempts).toBe(2);
      expect(terminalDiagnostics).toEqual([
        expect.objectContaining({ path: orphanHome, attempts: 2, error: expect.objectContaining({ code: 'EBUSY' }) }),
      ]);
    } finally {
      await removeTempDir(baseDir);
    }
  });
});
