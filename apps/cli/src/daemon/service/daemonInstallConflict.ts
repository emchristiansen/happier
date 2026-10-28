import { createServerUrlComparableKey } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import { happierHomeDirsMatch, resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';

export type DaemonServiceInstallStrategy = 'require-explicit' | 'add' | 'replace-ring' | 'replace-all';

/** The relay a daemon service serves: its server profile id and relay URL, each when known. */
export type DaemonServiceRelay = Readonly<{
  serverId: string | null;
  serverUrl: string | null;
}>;

export type DaemonServiceInstallTarget = Readonly<{
  platform: InstalledDaemonServiceEntry['platform'];
  mode: DaemonServiceMode;
  targetMode: DaemonServiceTargetMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  happierHomeDir: string | null;
  /** The server profile a pinned target serves (its `HAPPIER_ACTIVE_SERVER_ID`); absent = unknown. */
  activeServerId?: string | null;
  /** The relay URL a pinned target serves; absent = unknown. */
  serverUrl?: string | null;
  /**
   * The relay this home's default-following service currently serves (the persisted active
   * profile). Absent/`null` = unknown, which keeps a same-ring default-following service competing.
   */
  defaultFollowingServer?: DaemonServiceRelay | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
  exactTargetExists: boolean;
  exactTargetIsConverged: boolean;
  competingServices: readonly InstalledDaemonServiceEntry[];
  foreignHomeConflicts: readonly InstalledDaemonServiceEntry[];
  servicesToRemove: readonly InstalledDaemonServiceEntry[];
}>;

export function daemonServiceMatchesInstallTarget(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (service.platform !== target.platform) {
    return false;
  }
  if ((service.mode ?? 'user') !== target.mode) {
    return false;
  }
  if (service.targetMode !== target.targetMode) {
    return false;
  }
  if (!happierHomeDirsMatch(service.happierHomeDir, target.happierHomeDir)) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.releaseChannel === target.ring;
  }
  return service.releaseChannel === target.ring && service.serverId === target.instanceId;
}

function resolveTupleKey(service: InstalledDaemonServiceEntry): string {
  return [
    service.platform,
    service.mode ?? 'user',
    service.targetMode,
    service.releaseChannel,
    service.serverId,
    resolveHappierHomeDirComparableKey(service.happierHomeDir),
  ].join(':');
}

function isCompetingService(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (daemonServiceMatchesInstallTarget(service, target)) {
    return false;
  }
  if (service.platform !== target.platform) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.targetMode === 'default-following';
  }
  if (service.serverId === target.instanceId) {
    return true;
  }
  // Daemons are per relay: a pinned target competes on its ring only with a service for the same
  // relay, and with any service whose relay is unknown.
  if (service.releaseChannel !== target.ring) {
    return false;
  }
  const serviceRelay = resolveServiceRelay(service, target);
  return serviceRelay === null || daemonServiceRelaysMayMatch(serviceRelay, {
    serverId: target.activeServerId ?? null,
    serverUrl: target.serverUrl ?? null,
  });
}

function resolveServiceRelay(
  service: InstalledDaemonServiceEntry,
  target: DaemonServiceInstallTarget,
): DaemonServiceRelay | null {
  if (service.targetMode === 'pinned') {
    return resolvePinnedDaemonServiceRelay(service);
  }
  // A default-following service serves its own home's persisted active profile; only the
  // target home's is known here.
  const sameHome = happierHomeDirsMatch(service.happierHomeDir, target.happierHomeDir);
  return sameHome ? target.defaultFollowingServer ?? null : null;
}

/** The relay a pinned service serves: its baked `HAPPIER_ACTIVE_SERVER_ID` (else its unit id) and relay URL. */
export function resolvePinnedDaemonServiceRelay(service: Readonly<{
  serverId: string;
  activeServerId?: string | null;
  relayUrl?: string | null;
}>): DaemonServiceRelay {
  return {
    serverId: service.activeServerId ?? service.serverId,
    serverUrl: service.relayUrl ?? null,
  };
}

function resolveComparableRelayKey(serverUrl: string | null): string | null {
  const value = String(serverUrl ?? '').trim();
  if (!value) return null;
  try {
    return createServerUrlComparableKey(value) || null;
  } catch {
    return null;
  }
}

/**
 * The one "may these serve the same relay?" rule for daemon services (install conflicts and
 * background-service repair): same profile id (same lifecycle directory) or same relay URL key.
 * Unknown on both facts counts as the same, so an unidentifiable service is never treated as
 * serving another relay.
 */
export function daemonServiceRelaysMayMatch(left: DaemonServiceRelay, right: DaemonServiceRelay): boolean {
  const leftId = String(left.serverId ?? '').trim() || null;
  const rightId = String(right.serverId ?? '').trim() || null;
  const leftKey = resolveComparableRelayKey(left.serverUrl);
  const rightKey = resolveComparableRelayKey(right.serverUrl);
  const idsKnown = leftId !== null && rightId !== null;
  const keysKnown = leftKey !== null && rightKey !== null;
  if ((idsKnown && leftId === rightId) || (keysKnown && leftKey === rightKey)) {
    return true;
  }
  return !idsKnown && !keysKnown;
}

function isForeignHomeConflict(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  return !happierHomeDirsMatch(service.happierHomeDir, target.happierHomeDir);
}

function isReplaceAllAllowedForeignHomeCleanup(
  service: InstalledDaemonServiceEntry,
  target: DaemonServiceInstallTarget,
): boolean {
  return target.targetMode === 'default-following'
    && service.targetMode === 'default-following'
    && (service.mode ?? 'user') === target.mode
    && service.serverId === 'default';
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
  target: DaemonServiceInstallTarget;
  strategy: DaemonServiceInstallStrategy;
  services: readonly InstalledDaemonServiceEntry[];
}>): DaemonServiceInstallConflictPlan {
  const duplicateTupleKeys = new Set<string>();
  const countsByTuple = new Map<string, number>();
  for (const service of params.services) {
    const tupleKey = resolveTupleKey(service);
    const nextCount = (countsByTuple.get(tupleKey) ?? 0) + 1;
    countsByTuple.set(tupleKey, nextCount);
    if (nextCount > 1) {
      duplicateTupleKeys.add(tupleKey);
    }
  }

  const exactTargetExists = params.services.some((service) => daemonServiceMatchesInstallTarget(service, params.target));
  const competingServices = params.services.filter((service) =>
    isCompetingService(service, params.target) || duplicateTupleKeys.has(resolveTupleKey(service)),
  );
  const foreignHomeConflicts = competingServices.filter((service) =>
    isForeignHomeConflict(service, params.target)
    && (
      params.strategy !== 'replace-all'
      || !isReplaceAllAllowedForeignHomeCleanup(service, params.target)
    ),
  );

  const resolveServicesToRemove = (): readonly InstalledDaemonServiceEntry[] => {
    if (params.strategy === 'replace-all') {
      return competingServices.filter((service) => !foreignHomeConflicts.includes(service));
    }
    if (params.strategy === 'replace-ring') {
      return competingServices.filter((service) =>
        !foreignHomeConflicts.includes(service)
        && service.releaseChannel === params.target.ring,
      );
    }
    return [];
  };
  const servicesToRemove = resolveServicesToRemove();
  const servicesToRemoveSet = new Set(servicesToRemove);
  const exactTargetIsConverged = exactTargetExists && (
    competingServices.length === 0
    || competingServices.every((service) => servicesToRemoveSet.has(service))
  );

  return {
    exactTargetExists,
    exactTargetIsConverged,
    competingServices,
    foreignHomeConflicts,
    servicesToRemove,
  };
}
