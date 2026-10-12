import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import {
  getAgyAcpDepStatus,
  installAgyAcp,
  verifyExistingAgyAcpManagedBinPath,
} from '@/capabilities/deps/agyAcp';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';
import type { RuntimeInstallableAdapter, RuntimeInstallableLaunchResolution } from '@/installables/runtime/runtimeInstallablesRegistry';

export async function detectAgyAcpLaunchResolution(): Promise<RuntimeInstallableLaunchResolution> {
  try {
    resolveAgyAcpReleaseAsset();
  } catch (error) {
    return {
      availability: {
        ok: false,
        errorMessage: error instanceof Error ? error.message : 'Agy ACP server is not supported on this platform',
      },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    };
  }

  const managedPath = await verifyExistingAgyAcpManagedBinPath();
  if (managedPath) {
    return {
      availability: { ok: true },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    };
  }

  return {
    availability: { ok: false, errorMessage: 'Agy ACP server is not installed' },
    canAutoInstall: true,
    canBackgroundAutoUpdate: false,
  };
}

export async function runAgyAcpBackgroundAutoUpdateCheck(): Promise<void> {
  // Pinned v1.1.1 archive: no background auto-update. UI prewarm + launch-side
  // authoritative ensure own installation; a new pin lands as a new catalog fact.
}

export const agyAcpRuntimeInstallable: RuntimeInstallableAdapter = {
  key: INSTALLABLE_KEYS.AGY_ACP_SERVER,
  detectLaunchResolution: detectAgyAcpLaunchResolution,
  installOrUpgrade: installAgyAcp,
  runBackgroundAutoUpdateCheck: runAgyAcpBackgroundAutoUpdateCheck,
};

export async function getAgyAcpDepStatusForTests(): Promise<unknown> {
  return await getAgyAcpDepStatus();
}
