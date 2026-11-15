import { basename, isAbsolute, join, resolve } from 'node:path';

import type {
  ConnectedServiceCodexNativeSourceV1,
  ConnectedServiceId,
  ConnectedServiceProfileId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

type JoinPath = (...paths: string[]) => string;

const CONNECTED_SERVICE_GROUPS_HOME_SEGMENT = '__groups';

export type ConnectedServiceHomeSelection =
  | Readonly<{ kind: 'profile'; profileId: string; nativeSource?: ConnectedServiceCodexNativeSourceV1 }>
  | Readonly<{ kind: 'group'; groupId: string }>;

/**
 * The provider-scoped key of a profile home produced from a caller-nominated native source: the exact
 * resolved source pair. Each nominated pair therefore has its own home under the profile (the key's
 * path digest), no two pairs nor the profile's default home ever share one, and the same pair always
 * reaches the same home, whatever the working directory.
 */
export function connectedServiceNominatedNativeSourceHomeKey(
  nativeSource: ConnectedServiceCodexNativeSourceV1,
): string {
  // Only a path absolute on this platform is resolved: another platform's absolute syntax keeps its exact
  // text (its home is never working-directory-dependent; admission refuses it before any effect).
  const exact = (path: string) => (isAbsolute(path) ? resolve(path) : path);
  return `native-source:${JSON.stringify([exact(nativeSource.CODEX_HOME), exact(nativeSource.CODEX_SQLITE_HOME)])}`;
}

/** Whether `homeRoot` is the home a profile produces from exactly this nominated source. */
export function isConnectedServiceNominatedNativeSourceHomeRoot(
  homeRoot: string,
  nativeSource: ConnectedServiceCodexNativeSourceV1,
): boolean {
  return basename(resolve(homeRoot)) === normalizeMaterializationKeyForPath(connectedServiceNominatedNativeSourceHomeKey(nativeSource));
}

export function resolveConnectedServiceHomesDir(params: Readonly<{
  activeServerDir: string;
  pathJoin?: JoinPath;
}>): string {
  return (params.pathJoin ?? join)(params.activeServerDir, 'daemon', 'connected-services', 'homes');
}

export function resolveConnectedServiceSelectionHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  agentId: CatalogAgentId;
  fallbackProfileId: ConnectedServiceProfileId;
  selection?: ConnectedServiceHomeSelection | null;
}>): string {
  return params.selection?.kind === 'group'
    ? resolveConnectedServiceGroupHomeDir({ ...params, groupId: params.selection.groupId })
    : resolveConnectedServiceHomeDir({
        ...params,
        profileId: params.selection?.kind === 'profile' ? params.selection.profileId : params.fallbackProfileId,
        providerScopedKey: params.selection?.kind === 'profile' && params.selection.nativeSource
          ? connectedServiceNominatedNativeSourceHomeKey(params.selection.nativeSource)
          : null,
      });
}

export function resolveConnectedServiceHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
    resolveConnectedServiceHomesDir(params),
    params.serviceId,
    params.profileId,
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}

export function resolveConnectedServiceGroupHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
    resolveConnectedServiceHomesDir(params),
    params.serviceId,
    CONNECTED_SERVICE_GROUPS_HOME_SEGMENT,
    params.groupId,
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}
