import { removeConnectedServiceCredentialFiles } from '@/daemon/connectedServices/credentials/removeConnectedServiceCredentialFiles';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import type { AgentCatalogEntry } from '@/backends/types';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import { createCatalogDefinedAcpBackend } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createAgyAcpBackend } from './acp/backend';
import type { AccountSettings } from '@happier-dev/protocol';
import { agyDaemonSpawnHooks } from './daemon/spawnHooks';
import { createAgyConnectedServicesMaterializer } from './connectedServices/createAgyConnectedServicesMaterializer';
import { agyConnectedServiceStateSharingDescriptor } from './connectedServices/agyConnectedServiceStateSharingDescriptor';
import { resolveAgyConnectedServiceSwitchContinuity } from './connectedServices/resolveAgyConnectedServiceSwitchContinuity';
import { verifyResumeReachableAgy } from './connectedServices/verifyResumeReachableAgy';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { createAgyConnectedServiceRuntimeAuthAdapter } from './connectedServices/createAgyConnectedServiceRuntimeAuthAdapter';
import { agyQuotaFetcherDescriptor } from './connectedServices/quotaFetcher';
import { agyUsageLimitRecoveryControlAdapter } from './connectedServices/agyUsageLimitRecoveryControlAdapter';
import { classifyAgyAssistantTurnFailure, reportAgyTurnFailure } from './connectedServices/classifyAgyRuntimeQuotaFailure';

const agyCredentialLifecycle = {
  providerId: 'agy', serviceIds: ['antigravity'],
  credentialStorageCleanup: {
    async deleteCredentialStorageForHomeRoot({ rootDir }) {
      // Stable AGY homes are native roots; private probes wrap that root in gemini-home.
      await removeConnectedServiceCredentialFiles(rootDir, agyConnectedServiceStateSharingDescriptor.authIsolation.secretEntries.flatMap((entry) => [entry, `gemini-home/${entry}`]));
    },
  },
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: { mode: 'restart_required' },
  predictiveSoftSwitch: { mode: 'unsupported' },
  sameAccountFanoutStrategy: 'none', generationApplicationScope: 'per_session_runtime',
  runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
} satisfies ConnectedServiceCredentialLifecycleDescriptor;

const genericEntry = createCatalogDefinedAcpEntry('agy', {
  resolveAcpProbeLaunch: async () => {
    const { ensureAgyAcpServerForLaunch } = await import('./acp/ensureAgyAcpServerForLaunch');
    return ensureAgyAcpServerForLaunch({ readinessOnly: true });
  },
});

export const agent = {
  ...genericEntry,
  getCliCommandHandler: async () => (await import('./cli/command')).handleAgyCliCommand,
  getCapabilities: async () => (await import('./cli/extraCapabilities')).capabilities,
  getAcpBackendFactory: async () => {
    return async (opts) => {
      const options = opts as Parameters<typeof createCatalogDefinedAcpBackend>[1] & {
        accountSettings?: AccountSettings | null;
        readinessOnly?: boolean;
      };
      const { ensureAgyAcpServerForLaunch } = await import('./acp/ensureAgyAcpServerForLaunch');
      const launch = await ensureAgyAcpServerForLaunch({
        accountSettings: options.accountSettings,
        env: options.env,
        ...(options.readinessOnly ? { readinessOnly: true } : {}),
      });
      return { backend: createAgyAcpBackend({ ...options, launch }) };
    };
  },
  getDaemonSpawnHooks: async () => agyDaemonSpawnHooks,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).agyCloudConnect,
  getPreflightSessionControlsProbeAdapter: async () => ({ connectedServiceAuth: 'materialized-env' as const }),
  getConnectedServiceMaterializer: async () => createAgyConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => agyConnectedServiceStateSharingDescriptor,
  getConnectedServiceCredentialLifecycleDescriptor: async () => agyCredentialLifecycle,
  getConnectedServiceRuntimeAuthAdapter: async () => createAgyConnectedServiceRuntimeAuthAdapter(),
  getAcpRuntimeTurnHooks: async () => ({ classifyAssistantTurnFailure: classifyAgyAssistantTurnFailure, onTurnFailure: reportAgyTurnFailure }),
  connectedServiceQuotaFetcherDescriptor: agyQuotaFetcherDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => agyUsageLimitRecoveryControlAdapter,
  resolveConnectedServiceSwitchContinuity: resolveAgyConnectedServiceSwitchContinuity,
  verifyResumeReachable: verifyResumeReachableAgy,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
} satisfies AgentCatalogEntry;
