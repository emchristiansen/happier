import { assertOrdinaryReaderPath } from '@/rpc/handlers/pathSecurity';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';

export type CodexDirectSessionHomeEntry = Readonly<{
  codexHome: string;
  source: DirectSessionsSource;
}>;

function isSafeConnectedServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function isSafeConnectedServiceProfileId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function isSafeConnectedServiceGroupId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function normalizeConnectedServiceId(raw: unknown): string | null {
  if (!isSafeConnectedServiceId(raw)) return null;
  return raw.trim();
}

function normalizeConnectedServiceProfileId(raw: unknown): string | null {
  if (!isSafeConnectedServiceProfileId(raw)) return null;
  return raw.trim();
}

function normalizeConnectedServiceGroupId(raw: unknown): string | null {
  if (!isSafeConnectedServiceGroupId(raw)) return null;
  return raw.trim();
}

function normalizeHomePath(raw: string): string {
  return resolve(raw.trim());
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  if (rel.length === 0) return true;
  return !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

function resolveMaterializedRootsForActiveServerDir(activeServerDir: string): string[] {
  const normalizedActiveServerDir = resolve(activeServerDir);
  const roots = [
    join(normalizedActiveServerDir, 'daemon', 'connected-services', 'materialized'),
  ];
  const serversDir = dirname(normalizedActiveServerDir);
  if (basename(serversDir) === 'servers') {
    roots.unshift(join(dirname(serversDir), 'daemon', 'connected-services', 'materialized'));
  }
  return Array.from(new Set(roots));
}

function buildConnectedServiceCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceProfileId: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId, connectedServiceProfileId, 'codex', 'codex-home');
}

function buildConnectedServiceGroupCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceGroupId: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId, '__groups', connectedServiceGroupId, 'codex', 'codex-home');
}

async function resolveVerifiedCodexHomePath(expectedPath: string, exactHomePath: string | null): Promise<string | null> {
  const targetPath = exactHomePath ?? expectedPath;
  try {
    const linkStats = await lstat(targetPath);
    if (linkStats.isSymbolicLink()) {
      return null;
    }
    const real = await realpath(targetPath);
    const expectedReal = await realpath(expectedPath).catch(() => null);
    if (!expectedReal || real !== expectedReal) {
      return null;
    }
    const stats = await stat(real);
    return stats.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function resolveVerifiedMaterializedCodexHomePathInRoot(materializedRootInput: string, exactHomePath: string): Promise<string | null> {
  const materializedRoot = resolve(materializedRootInput);
  if (!isPathWithin(exactHomePath, materializedRoot)) return null;
  const relativeParts = relative(materializedRoot, exactHomePath).split(/[/\\]+/).filter(Boolean);
  if (relativeParts.length !== 3 || relativeParts[1] !== 'codex' || relativeParts[2] !== 'codex-home') {
    return null;
  }
  try {
    const linkStats = await lstat(exactHomePath);
    if (linkStats.isSymbolicLink()) {
      return null;
    }
    const materializedRootReal = await realpath(materializedRoot);
    const real = await realpath(exactHomePath);
    if (!isPathWithin(real, materializedRootReal)) {
      return null;
    }
    const stats = await stat(real);
    return stats.isDirectory() ? exactHomePath : null;
  } catch {
    return null;
  }
}

async function resolveVerifiedMaterializedCodexHomePath(activeServerDir: string, exactHomePath: string | null): Promise<string | null> {
  if (!exactHomePath) return null;
  for (const materializedRoot of resolveMaterializedRootsForActiveServerDir(activeServerDir)) {
    const verified = await resolveVerifiedMaterializedCodexHomePathInRoot(materializedRoot, exactHomePath);
    if (verified) return verified;
  }
  return null;
}

export function inferCodexDirectSessionsSourceFromHome(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): DirectSessionsSource {
  const codexHome = typeof params.codexHome === 'string' && params.codexHome.trim().length > 0
    ? normalizeHomePath(params.codexHome)
    : normalizeHomePath(join(homedir(), '.codex'));
  const activeServerDir = typeof params.activeServerDir === 'string' && params.activeServerDir.trim().length > 0
    ? resolve(params.activeServerDir.trim())
    : null;

  if (activeServerDir) {
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
    const relativeParts = codexHome.startsWith(`${homesRoot}/`) || codexHome.startsWith(`${homesRoot}\\`)
      ? codexHome.slice(homesRoot.length + 1).split(/[/\\]+/)
      : null;
    if (relativeParts && relativeParts.length === 4 && relativeParts[2] === 'codex' && relativeParts[3] === 'codex-home') {
      const [rawConnectedServiceId, rawConnectedServiceProfileId] = relativeParts;
      const connectedServiceId = normalizeConnectedServiceId(rawConnectedServiceId);
      const connectedServiceProfileId = normalizeConnectedServiceProfileId(rawConnectedServiceProfileId);
      if (connectedServiceId && connectedServiceProfileId) {
        return {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceProfileId,
          homePath: codexHome,
        };
      }
    }
    if (relativeParts && relativeParts.length === 5 && relativeParts[1] === '__groups' && relativeParts[3] === 'codex' && relativeParts[4] === 'codex-home') {
      const [rawConnectedServiceId,, rawConnectedServiceGroupId] = relativeParts;
      const connectedServiceId = normalizeConnectedServiceId(rawConnectedServiceId);
      const connectedServiceGroupId = normalizeConnectedServiceGroupId(rawConnectedServiceGroupId);
      if (connectedServiceId && connectedServiceGroupId) {
        return {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceGroupId,
          homePath: codexHome,
        };
      }
    }
  }

  return {
    kind: 'codexHome',
    home: 'user',
    homePath: codexHome,
  };
}

async function resolveCodexHomeEntriesUnchecked(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<CodexDirectSessionHomeEntry[]> {
  if (params.source.kind !== 'codexHome') return [];

  if (params.source.home === 'user') {
    const codexHome = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
      ? normalizeHomePath(params.source.homePath)
      : normalizeHomePath(resolveConfiguredCodexHome(params.env));
    return [{ codexHome, source: { kind: 'codexHome', home: 'user', homePath: codexHome } }];
  }

  const connectedServiceId = normalizeConnectedServiceId(params.source.connectedServiceId);
  if (!connectedServiceId) return [];

  const connectedServiceProfileId = normalizeConnectedServiceProfileId(params.source.connectedServiceProfileId);
  const connectedServiceGroupId = normalizeConnectedServiceGroupId(params.source.connectedServiceGroupId);
  const exactHomePath = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
    ? normalizeHomePath(params.source.homePath)
    : null;

  if (connectedServiceProfileId) {
    const materializedHome = await resolveVerifiedMaterializedCodexHomePath(params.activeServerDir, exactHomePath);
    if (materializedHome) {
      return [{
        codexHome: materializedHome,
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceProfileId,
          homePath: materializedHome,
        },
      }];
    }
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, connectedServiceProfileId);
    const verifiedHome = await resolveVerifiedCodexHomePath(codexHome, exactHomePath);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        connectedServiceProfileId,
        homePath: verifiedHome,
      },
    }];
  }

  if (connectedServiceGroupId) {
    const materializedHome = await resolveVerifiedMaterializedCodexHomePath(params.activeServerDir, exactHomePath);
    if (materializedHome) {
      return [{
        codexHome: materializedHome,
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceGroupId,
          homePath: materializedHome,
        },
      }];
    }
    const codexHome = buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, connectedServiceGroupId);
    const verifiedHome = await resolveVerifiedCodexHomePath(codexHome, exactHomePath);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        connectedServiceGroupId,
        homePath: verifiedHome,
      },
    }];
  }

  if (exactHomePath) {
    const inferred = inferCodexDirectSessionsSourceFromHome({ codexHome: exactHomePath, activeServerDir: params.activeServerDir });
    if (inferred.kind !== 'codexHome' || inferred.home !== 'connectedService') {
      return [];
    }
    const inferredProfileId = normalizeConnectedServiceProfileId(inferred.connectedServiceProfileId);
    const inferredGroupId = normalizeConnectedServiceGroupId(inferred.connectedServiceGroupId);
    if (inferred.connectedServiceId !== connectedServiceId || (!inferredProfileId && !inferredGroupId)) {
      return [];
    }
    const expectedPath = inferredProfileId
      ? buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, inferredProfileId)
      : buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, inferredGroupId!);
    const verifiedHome = await resolveVerifiedCodexHomePath(expectedPath, exactHomePath);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        ...(inferredProfileId ? { connectedServiceProfileId: inferredProfileId } : {}),
        ...(inferredGroupId ? { connectedServiceGroupId: inferredGroupId } : {}),
        homePath: verifiedHome,
      },
    }];
  }

  const entries: CodexDirectSessionHomeEntry[] = [];
  const base = join(params.activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId);
  let profiles: Dirent[];
  try {
    profiles = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of profiles) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === '__groups') continue;
    const profileId = normalizeConnectedServiceProfileId(entry.name);
    if (!profileId) continue;
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, profileId);
    try {
      const s = await stat(codexHome);
      if (s.isDirectory()) {
        entries.push({
          codexHome,
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId,
            connectedServiceProfileId: profileId,
            homePath: codexHome,
          },
        });
      }
    } catch {
      // ignore missing
    }
  }

  const groupsBase = join(base, '__groups');
  let groups: Dirent[];
  try {
    groups = await readdir(groupsBase, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const entry of groups) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const groupId = normalizeConnectedServiceGroupId(entry.name);
    if (!groupId) continue;
    const codexHome = buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, groupId);
    try {
      const s = await stat(codexHome);
      if (s.isDirectory()) {
        entries.push({
          codexHome,
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId,
            connectedServiceGroupId: groupId,
            homePath: codexHome,
          },
        });
      }
    } catch {
      // ignore missing
    }
  }

  return entries;
}


export async function resolveCodexHomeEntriesForDirectSessionsSource(
  params: Parameters<typeof resolveCodexHomeEntriesUnchecked>[0],
): Promise<CodexDirectSessionHomeEntry[]> {
  const entries = await resolveCodexHomeEntriesUnchecked(params);
  for (const entry of entries) assertOrdinaryReaderPath(entry.codexHome);
  return entries;
}
