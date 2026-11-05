import { deleteClaudeCodeMacOsKeychainCredential } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeMacOsKeychain';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { buildDefaultConnectedServiceCredentialLifecycleDescriptor } from '../credentials/lifecycleTypes';
import { ConnectedServiceGroupHomeCleanupScheduler } from './ConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';

vi.mock('@/backends/claude/connectedServices/nativeAuth/claudeCodeMacOsKeychain', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/backends/claude/connectedServices/nativeAuth/claudeCodeMacOsKeychain')>(),
  deleteClaudeCodeMacOsKeychainCredential: vi.fn(async () => {}),
}));

describe('ConnectedServiceGroupHomeCleanupScheduler', () => {
  it('retains history in expired group quarantine while removing only credentials', async () => {
    const root = await createTempDir('happier-retained-group-history-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root, serviceId: 'openai-codex', groupId: 'deleted', agentId: 'codex',
      });
      await mkdir(join(home, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(join(home, 'codex-home', 'sessions', 'session.jsonl'), 'distinct deleted-group history\n');
      await writeFile(join(home, 'codex-home', 'auth.json'), 'synthetic group credential');
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, hasLiveTarget: () => false, nowMs: () => 100_000,
        quarantineTtlMs: 0,
      });
      await scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex', groupId: 'deleted', agentId: 'codex',
      });
      // Reconstruct the scheduler to exercise startup against an existing quarantine.
      await new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, hasLiveTarget: () => false, nowMs: () => 200_000,
        quarantineTtlMs: 0,
      }).reconcileDeletedGroupHomes({});
      const quarantine = join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'deleted', '.quarantine');
      const entries = await readdir(quarantine);
      expect(entries).toHaveLength(1);
      const retained = join(quarantine, entries[0], 'codex-home');
      await expect(readFile(join(retained, 'sessions', 'session.jsonl'), 'utf8')).resolves.toBe('distinct deleted-group history\n');
      await expect(stat(join(retained, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });

  it('revokes the original Claude Keychain identity before rename without touching a recreated live group', async () => {
    const root = await createTempDir('happier-retained-claude-group-');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const deletion = vi.mocked(deleteClaudeCodeMacOsKeychainCredential);
    deletion.mockClear();
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    try {
      const home = resolveConnectedServiceGroupHomeDir({ activeServerDir: root, serviceId: 'claude-subscription', groupId: 'pool', agentId: 'claude' });
      await mkdir(join(home, 'claude-config', 'projects'), { recursive: true });
      await writeFile(join(home, 'claude-config', 'projects', 'session.jsonl'), 'old group history\n');
      await writeFile(join(home, 'claude-config', '.credentials.json'), 'old synthetic credential');
      let live = false;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, hasLiveTarget: () => live, nowMs: () => 100_000, quarantineTtlMs: 0,
      });
      await scheduler.scheduleDeletedGroupCleanup({ serviceId: 'claude-subscription', groupId: 'pool', agentId: 'claude' });
      expect(deletion).toHaveBeenCalledExactlyOnceWith({ claudeConfigDir: join(home, 'claude-config') });
      await mkdir(join(home, 'claude-config'), { recursive: true });
      await writeFile(join(home, 'claude-config', '.credentials.json'), 'current synthetic credential');
      live = true;
      await scheduler.reconcileDeletedGroupHomes({ groupExists: async () => true });
      expect(deletion).toHaveBeenCalledTimes(1);
      expect(await readFile(join(home, 'claude-config', '.credentials.json'), 'utf8')).toBe('current synthetic credential');
      const retired = join(home, '..', '.quarantine', '100000-claude', 'claude-config');
      expect(await readFile(join(retired, 'projects', 'session.jsonl'), 'utf8')).toBe('old group history\n');
      await expect(stat(join(retired, '.credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
      await removeTempDir(root);
    }
  });

  it('keeps a live execution Run pool home until its canonical runtime registration releases', async () => {
    const root = await createTempDir('happier-group-home-live-run-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root, serviceId: 'openai-codex', groupId: 'main', agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'run-history.jsonl'), 'private live Run history\n');
      const registry = new ConnectedServiceRuntimeRegistry();
      registry.registerRunTarget({
        runKey: 'execution_run:live', pid: 4321, agentId: 'codex', materializationKey: 'execution_run:live',
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'main', profileId: 'work' },
        } },
      });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, runtimeRegistry: registry, hasLiveTarget: () => false,
        resolveGroupDeletionAuthority: async () => ({ status: 'deleted' }),
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex', groupId: 'main', agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      expect(await readFile(join(home, 'run-history.jsonl'), 'utf8')).toBe('private live Run history\n');

      registry.unregisterRunKey('execution_run:live');
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });

  it('quarantines a deleted group home only after no live target references it', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => true,
      });

      await scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await expect(stat(home)).resolves.toBeTruthy();

      const readyScheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => false,
      });
      await readyScheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      const quarantined = await readdir(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', '.quarantine'));
      expect(quarantined).toHaveLength(1);
      await expect(stat(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', '.quarantine', quarantined[0]))).resolves.toBeTruthy();
      expect(home).toBe(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', 'codex'));
    } finally {
      await removeTempDir(root);
    }
  });

  it('revokes Claude credentials at the original group path before quarantine and retains expired history', async () => {
    const root = await createTempDir('happier-connected-service-group-home-claude-keychain-cleanup-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'anthropic',
        groupId: 'main',
        agentId: 'claude',
      });
      await mkdir(join(home, 'claude-config'), { recursive: true });
      const deletedClaudeConfigDirs: string[] = [];
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => false,
        nowMs: () => 100_000,
        quarantineTtlMs: 0,
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

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'anthropic',
        groupId: 'main',
        agentId: 'claude',
      })).resolves.toMatchObject({ cleaned: true });
      expect(deletedClaudeConfigDirs).toEqual([join(home, 'claude-config')]);

      await expect(scheduler.reconcileDeletedGroupHomes({})).resolves.toEqual([]);
      const quarantineRoot = join(root, 'daemon', 'connected-services', 'homes', 'anthropic', '__groups', 'main', '.quarantine');
      expect(deletedClaudeConfigDirs).toEqual([
        join(home, 'claude-config'),
        join(quarantineRoot, '100000-claude', 'claude-config'),
      ]);
      await expect(readdir(quarantineRoot)).resolves.toEqual(['100000-claude']);
    } finally {
      await removeTempDir(root);
    }
  });

  it('remembers deleted group homes and removes them when live targets disappear later', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-deferred-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it('does not delete a pending group home when the group was recreated with the same id', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-recreated-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
        groupExists: async ({ groupId }) => groupId === 'main',
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });

  it('does not delete a pending group home when deletion authority is indeterminate', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-indeterminate-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
        resolveGroupDeletionAuthority: async () => ({ status: 'unknown' }),
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });

  it('keeps a failed pending cleanup retryable instead of dropping the target', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-retry-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      let removeAttempts = 0;
      const removePath: typeof rm = async () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      };
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
        removePath,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      expect(removeAttempts).toBe(1);

      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      expect(removeAttempts).toBe(2);
    } finally {
      await removeTempDir(root);
    }
  });

  it('reconciles existing group homes whose server group is gone without deleting live targets', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-reconcile-');
    try {
      const deletedHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'deleted',
        agentId: 'codex',
      });
      const liveDeletedHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'live-deleted',
        agentId: 'codex',
      });
      const existingHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'existing',
        agentId: 'codex',
      });
      await mkdir(deletedHome, { recursive: true });
      await mkdir(liveDeletedHome, { recursive: true });
      await mkdir(existingHome, { recursive: true });

      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: ({ groupId }) => groupId === 'live-deleted',
      });

      await expect(scheduler.reconcileDeletedGroupHomes({
        groupExists: async ({ groupId }) => groupId === 'existing',
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ cleaned: true, path: deletedHome }),
        expect.objectContaining({ cleaned: false, pending: true, path: liveDeletedHome }),
      ]));
      await expect(stat(deletedHome)).rejects.toMatchObject({ code: 'ENOENT' });
      const quarantineRoot = join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'deleted', '.quarantine');
      await expect(readdir(quarantineRoot)).resolves.toHaveLength(1);
      await expect(stat(liveDeletedHome)).resolves.toBeTruthy();
      await expect(stat(existingHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });

  it('keeps existing group homes when deletion is not positively confirmed', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-unknown-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'gate-off',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => false,
      });

      await expect(scheduler.reconcileDeletedGroupHomes({
        resolveGroupDeletionAuthority: async () => ({ status: 'unknown' }),
      })).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });
});
