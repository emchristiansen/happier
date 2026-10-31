import { join } from 'node:path';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';

export function createClaudeConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const claudeSubscription = params.recordsByServiceId.get('claude-subscription') ?? null;
    const anthropic = params.recordsByServiceId.get('anthropic') ?? null;

    if (claudeSubscription) {
      const selection = params.selectionsByServiceId?.get('claude-subscription');
      const materialized = await materializeClaudeConnectedServiceSelection({
        activeServerDir: params.activeServerDir,
        probeConfigDir: params.materializationPurpose === 'probe' ? join(params.rootDir, 'claude-config') : undefined,
        serviceId: 'claude-subscription',
        record: claudeSubscription,
        fallbackProfileId: claudeSubscription.profileId,
        selection,
        processEnv: params.processEnv ?? process.env,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        sessionStateMode: params.sessionStateMode,
        validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
      });
      if (!materialized) return null;
      return {
        env: materialized.env,
        targetMaterializedRoot: materialized.targetMaterializedRoot,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        diagnostics: materialized.diagnostics,
      };
    }

    if (!anthropic) return null;
    const selection = params.selectionsByServiceId?.get('anthropic');
    const materialized = await materializeClaudeConnectedServiceSelection({
      activeServerDir: params.activeServerDir,
      probeConfigDir: params.materializationPurpose === 'probe' ? join(params.rootDir, 'claude-config') : undefined,
      serviceId: 'anthropic',
      record: anthropic,
      fallbackProfileId: anthropic.profileId,
      selection,
      processEnv: params.processEnv ?? process.env,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      sessionStateMode: params.sessionStateMode,
      validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
    });
    if (!materialized) return null;
    return {
      env: materialized.env,
      targetMaterializedRoot: materialized.targetMaterializedRoot,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      diagnostics: materialized.diagnostics,
    };
  };
}
