import { readCachedCliUpdateState } from '@happier-dev/cli-common/update';
import type { PublicReleaseRingId, PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { maybeRefreshCliUpdateCacheInBackground } from '@/cli/runtime/update/autoUpdateNotice';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';

import type { CliSelfUpdateAvailable, RepairFinding } from './types';

/**
 * Whether a newer CLI is published on the user's release channel, as the one update-check owner
 * cached it (plan R13 S-1): `happier self check` writes the ring's cache — from the acquisition
 * owner's release lookup for binary installs, npm for npm installs — and this reads it through the
 * same ring-filtered reader as the terminal notice and the daemon's update facts. Doctor never
 * writes the cache and never makes the network call itself; when the cache is stale (always, for a
 * `forceRefresh` run) it starts the existing background check, whose answer the next run shows.
 */
export async function classifyCurrentCli(params: Readonly<{
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliRingId: PublicReleaseRingId;
  currentCliVersion: string;
  forceRefresh?: boolean;
  onMigration?: boolean;
  homeDir?: string;
}>): Promise<readonly RepairFinding[]> {
  const homeDir = params.homeDir ?? configuration.happyHomeDir;
  maybeRefreshCliUpdateCacheInBackground({
    homeDir,
    cliRootDir: projectPath(),
    env: process.env,
    publicReleaseRing: params.currentCliRingId,
    ...(params.forceRefresh ? { checkIntervalMs: 0 } : {}),
  });
  if (!params.currentCliVersion) return [];
  const state = readCachedCliUpdateState({
    homeDir,
    publicReleaseRing: params.currentCliRingId,
    currentVersion: params.currentCliVersion,
  });
  if (!state?.updateAvailable || !state.latestVersion) return [];

  const finding: CliSelfUpdateAvailable = {
    kind: 'cli_self_update_available',
    severity: 'info',
    // Self-update is material; users should always confirm. Never auto-apply.
    autoApplyWithoutPrompt: false,
    releaseChannel: params.currentCliReleaseChannel,
    currentVersion: params.currentCliVersion,
    latestVersion: state.latestVersion,
  };
  return [finding];
}
