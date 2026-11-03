import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { AGENT_IDS } from '@happier-dev/agents';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '../credentials/lifecycleTypes';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import {
  createPendingPathCleanupQueue,
  type PendingPathCleanupRetryExhaustedEvent,
} from '../cleanup/PendingPathCleanupQueue';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';

export const CONNECTED_SERVICE_GROUP_HOME_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60_000;

type DeletedGroupCleanupTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  path: string;
  cleanupAttempts?: number;
  lastCleanupError?: unknown;
}>;

type DeletedGroupCleanupResult = Readonly<{
  cleaned: boolean;
  pending?: boolean;
  path: string;
}>;

type GroupHomeTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>;

type GroupExists = (target: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => Promise<boolean>;

export type ConnectedServiceGroupDeletionAuthority = Readonly<{
  status: 'exists' | 'deleted' | 'unknown';
}>;

type ResolveGroupDeletionAuthority = (target: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => Promise<ConnectedServiceGroupDeletionAuthority>;

type ResolveCredentialLifecycleDescriptor = (
  agentId: CatalogAgentId,
) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;

function parseQuarantineAgentId(entryName: string): CatalogAgentId | null {
  const marker = entryName.indexOf('-');
  if (marker <= 0) return null;
  const suffix = entryName.slice(marker + 1);
  for (const agentId of [...AGENT_IDS].sort((left, right) => right.length - left.length)) {
    if (suffix === agentId) return agentId;
    const attemptSuffix = suffix.slice(agentId.length + 1);
    if (suffix.startsWith(`${agentId}-`) && /^\d+$/.test(attemptSuffix)) return agentId;
  }
  return null;
}

function targetKey(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>): string {
  return `${input.serviceId}\0${input.groupId}\0${input.agentId}`;
}

async function readDirectoryNames(path: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parseAgentId(value: string): CatalogAgentId | null {
  return (AGENT_IDS as ReadonlyArray<string>).includes(value) ? value as CatalogAgentId : null;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function quarantineEntryTimestamp(entryName: string): number | null {
  const marker = entryName.indexOf('-');
  if (marker <= 0) return null;
  const value = Number(entryName.slice(0, marker));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export class ConnectedServiceGroupHomeCleanupScheduler {
  private readonly cleanupQueue: ReturnType<typeof createPendingPathCleanupQueue<DeletedGroupCleanupTarget>>;
  private readonly nowMs: () => number;
  private readonly quarantineTtlMs: number;
  private readonly renamePath: typeof rename;
  private readonly resolveCredentialLifecycleDescriptor: ResolveCredentialLifecycleDescriptor;

  constructor(private readonly deps: Readonly<{
    activeServerDir: string;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    hasLiveTarget(input: Readonly<{
      serviceId: ConnectedServiceId;
      groupId: string;
      agentId: CatalogAgentId;
    }>): boolean;
    groupExists?: GroupExists;
    resolveGroupDeletionAuthority?: ResolveGroupDeletionAuthority;
    maxCleanupRetries?: number;
    removePath?: typeof rm;
    renamePath?: typeof rename;
    resolveCredentialLifecycleDescriptor?: ResolveCredentialLifecycleDescriptor;
    nowMs?: () => number;
    quarantineTtlMs?: number;
    onCleanupRetryExhausted?: (event: PendingPathCleanupRetryExhaustedEvent<DeletedGroupCleanupTarget>) => void;
  }>) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.quarantineTtlMs = Math.max(0, Math.trunc(deps.quarantineTtlMs ?? CONNECTED_SERVICE_GROUP_HOME_QUARANTINE_TTL_MS));
    this.renamePath = deps.renamePath ?? rename;
    this.resolveCredentialLifecycleDescriptor = deps.resolveCredentialLifecycleDescriptor
      ?? resolveConnectedServiceCredentialLifecycleDescriptor;
    this.cleanupQueue = createPendingPathCleanupQueue<DeletedGroupCleanupTarget>({
      maxCleanupRetries: deps.maxCleanupRetries,
      removePath: deps.removePath ?? (async (path) => {
        await this.quarantineGroupHome(path);
      }),
      beforeRemove: async (target) => {
        // Revoke at the original path, before its path-hashed Keychain identity changes.
        const descriptor = await this.resolveCredentialLifecycleDescriptor(target.agentId);
        await descriptor.credentialStorageCleanup?.deleteCredentialStorageForHomeRoot({
          rootDir: target.path, kind: 'group_home',
        });
      },
      onRetryExhausted: deps.onCleanupRetryExhausted,
    });
  }

  private async deleteQuarantinedCredentialStorage(input: Readonly<{
    entryName: string;
    quarantinedPath: string;
  }>): Promise<void> {
    const agentId = parseQuarantineAgentId(input.entryName);
    if (!agentId) return;
    const descriptor = await this.resolveCredentialLifecycleDescriptor(agentId);
    await descriptor.credentialStorageCleanup?.deleteCredentialStorageForHomeRoot({
      rootDir: input.quarantinedPath,
      kind: 'group_home_quarantine',
    });
  }

  private async quarantineGroupHome(path: string): Promise<void> {
    const groupRoot = dirname(path);
    const quarantineRoot = join(groupRoot, '.quarantine');
    const entryBase = `${this.nowMs()}-${basename(path)}`;
    await mkdir(quarantineRoot, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const quarantinePath = join(quarantineRoot, attempt === 0 ? entryBase : `${entryBase}-${attempt}`);
      try {
        await this.renamePath(path, quarantinePath);
        return;
      } catch (error) {
        if (hasNodeErrorCode(error, 'ENOENT')) return;
        if (hasNodeErrorCode(error, 'EEXIST')) continue;
        throw error;
      }
    }
    throw new Error(`Failed to allocate connected-service group-home quarantine path for ${path}`);
  }

  private async revokeExpiredQuarantineCredentials(): Promise<void> {
    const homesRoot = join(this.deps.activeServerDir, 'daemon', 'connected-services', 'homes');
    const nowMs = this.nowMs();
    for (const serviceDirName of await readDirectoryNames(homesRoot)) {
      const serviceId = ConnectedServiceIdSchema.safeParse(serviceDirName);
      if (!serviceId.success) continue;
      const groupsRoot = join(homesRoot, serviceDirName, '__groups');
      for (const groupId of await readDirectoryNames(groupsRoot)) {
        const quarantineRoot = join(groupsRoot, groupId, '.quarantine');
        for (const entryName of await readDirectoryNames(quarantineRoot)) {
          const quarantinedAtMs = quarantineEntryTimestamp(entryName);
          if (quarantinedAtMs === null || nowMs - quarantinedAtMs < this.quarantineTtlMs) continue;
          const quarantinedPath = join(quarantineRoot, entryName);
          await this.deleteQuarantinedCredentialStorage({ entryName, quarantinedPath });
          // Quarantine retains history indefinitely, including across daemon restarts.
        }
      }
    }
  }

  private async resolveDeletionAuthority(target: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceGroupDeletionAuthority | null> {
    if (this.deps.resolveGroupDeletionAuthority) {
      return await this.deps.resolveGroupDeletionAuthority(target);
    }
    if (this.deps.groupExists) {
      return (await this.deps.groupExists(target)) ? { status: 'exists' } : { status: 'deleted' };
    }
    return null;
  }

  private hasLiveTarget(target: GroupHomeTarget): boolean {
    return this.deps.runtimeRegistry?.listTargets().some((runtimeTarget) => (
      runtimeTarget.agentId === target.agentId
      && runtimeTarget.activeBindings.some((binding) => (
        binding.serviceId === target.serviceId && binding.groupId === target.groupId
      ))
    )) === true || this.deps.hasLiveTarget(target);
  }

  async scheduleDeletedGroupCleanup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    agentId: CatalogAgentId;
  }>): Promise<DeletedGroupCleanupResult> {
    const path = resolveConnectedServiceGroupHomeDir({
      activeServerDir: this.deps.activeServerDir,
      serviceId: input.serviceId,
      groupId: input.groupId,
      agentId: input.agentId,
    });
    if (this.hasLiveTarget(input)) {
      this.cleanupQueue.setPending(targetKey(input), { ...input, path });
      return { cleaned: false, pending: true, path };
    }
    await this.cleanupQueue.removeNow(targetKey(input), { ...input, path });
    return { cleaned: true, path };
  }

  private async listExistingGroupHomeTargets(): Promise<ReadonlyArray<GroupHomeTarget>> {
    const homesRoot = join(this.deps.activeServerDir, 'daemon', 'connected-services', 'homes');
    const targets: GroupHomeTarget[] = [];
    for (const serviceDirName of await readDirectoryNames(homesRoot)) {
      const serviceId = ConnectedServiceIdSchema.safeParse(serviceDirName);
      if (!serviceId.success) continue;
      const groupsRoot = join(homesRoot, serviceDirName, '__groups');
      for (const groupId of await readDirectoryNames(groupsRoot)) {
        const groupRoot = join(groupsRoot, groupId);
        for (const agentDirName of await readDirectoryNames(groupRoot)) {
          const agentId = parseAgentId(agentDirName);
          if (!agentId) continue;
          targets.push({ serviceId: serviceId.data, groupId, agentId });
        }
      }
    }
    return targets;
  }

  async reconcileDeletedGroupHomes(input: Readonly<{
    groupExists?: GroupExists;
    resolveGroupDeletionAuthority?: ResolveGroupDeletionAuthority;
  }>): Promise<ReadonlyArray<DeletedGroupCleanupResult>> {
    await this.revokeExpiredQuarantineCredentials();
    const resolveGroupDeletionAuthority = input.resolveGroupDeletionAuthority ?? this.deps.resolveGroupDeletionAuthority;
    const groupExists = input.groupExists ?? this.deps.groupExists;
    if (!resolveGroupDeletionAuthority && !groupExists) return [];
    const results: DeletedGroupCleanupResult[] = [];
    for (const target of await this.listExistingGroupHomeTargets()) {
      const authority = resolveGroupDeletionAuthority
        ? await resolveGroupDeletionAuthority(target)
        : (await groupExists!(target)) ? { status: 'exists' as const } : { status: 'deleted' as const };
      if (authority.status !== 'deleted') continue;
      results.push(await this.scheduleDeletedGroupCleanup(target));
    }
    return results;
  }

  async cleanupPendingDeletedGroupHomes(): Promise<ReadonlyArray<Readonly<{ cleaned: true; path: string }>>> {
    return await this.cleanupQueue.drainPending({
      shouldDropPending: async (target) => {
        const authority = await this.resolveDeletionAuthority(target);
        return authority?.status === 'exists';
      },
      shouldKeepPending: async (target) => {
        if (this.hasLiveTarget(target)) return true;
        const authority = await this.resolveDeletionAuthority(target);
        return authority?.status === 'unknown';
      },
      toCleanedResult: (target) => ({ cleaned: true, path: target.path }),
    });
  }
}
