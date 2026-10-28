import { join } from 'node:path';
import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';

import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { DEFAULT_MANIFEST_NAME, LEGACY_CODEX_MANIFEST_NAME } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { codexConnectedServiceStateSharingDescriptor } from './codexConnectedServiceStateSharingDescriptor';
import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';
import { resolveConnectedServiceHomesDir, resolveConnectedServiceSelectionHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { resolveConnectedServicePreviousStateRoot } from '@/daemon/connectedServices/materialize/resolveConnectedServicePreviousStateRoot';

function resolveCodexHomeHappierOwnedEntryNames(): string[] {
  const descriptor = codexConnectedServiceStateSharingDescriptor;
  return [...new Set([
    ...descriptor.config.entries.map((entry) => entry.path.split('/')[0]),
    ...descriptor.state.entries.map((entry) => entry.path.split('/')[0]),
    ...descriptor.authIsolation.secretEntries,
    DEFAULT_MANIFEST_NAME,
    LEGACY_CODEX_MANIFEST_NAME,
  ])];
}

export function createCodexConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const codex = params.recordsByServiceId.get('openai-codex') ?? null;
    const openai = params.recordsByServiceId.get('openai') ?? null;

    if (codex) {
      const selection = params.selectionsByServiceId?.get('openai-codex');
      const validateGroupMutationCurrentness = params.validateGroupMutationCurrentness;
      const previousDescriptor = readSessionMetadataRuntimeDescriptor(params.existingSessionMetadata, 'codex');
      const managedRoots = [
        resolveConnectedServiceHomesDir(params),
        // The common owner supplies only the previous session/run root, not an ambient home.
        ...(params.previousMaterializedRoot ? [params.previousMaterializedRoot] : []),
      ];
      const previousCodexHome = params.materializationPurpose === 'probe'
        ? null
        : await resolveConnectedServicePreviousStateRoot({
            previousRoot: previousDescriptor?.home === 'connectedService' ? previousDescriptor.homePath : null,
            managedRoots,
          }) ?? await resolveConnectedServicePreviousStateRoot({
            previousRoot: params.previousMaterializedRoot ? join(params.previousMaterializedRoot, 'codex-home') : null,
            managedRoots,
          });
      const rootDir = params.materializationPurpose !== 'probe'
        ? resolveConnectedServiceSelectionHomeDir({
            activeServerDir: params.activeServerDir,
            serviceId: 'openai-codex',
            agentId: 'codex',
            fallbackProfileId: codex.profileId,
            selection,
          })
        : params.rootDir;
      const write = () => materializeCodexConnectedServiceAuth({
        rootDir,
        activeServerDir: params.activeServerDir,
        vendorResumeId: params.vendorResumeId,
        previousCodexHome,
        record: codex,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
        sessionStateMode: params.sessionStateMode,
        validateCurrentBeforeMutation: selection?.kind === 'group' && validateGroupMutationCurrentness
          ? () => validateGroupMutationCurrentness({
              serviceId: 'openai-codex',
              groupId: selection.groupId,
              profileId: selection.activeProfileId,
              generation: selection.generation,
              credentialRevision: selection.credentialRevision ?? null,
            })
          : undefined,
      });
      const materialized = await (params.writeArtifacts ? params.writeArtifacts(write) : write());

      return {
        env: materialized.env,
        targetMaterializedRoot: materialized.targetMaterializedRoot,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        preserveUnprovidedEntriesAcrossPromotion: [{ root: 'codex-home', exclude: resolveCodexHomeHappierOwnedEntryNames() }],
        ...(materialized.diagnostics && materialized.diagnostics.length > 0
          ? { diagnostics: materialized.diagnostics }
          : {}),
      };
    }

    if (!openai) return null;
    const token = requireConnectedServiceTokenCredentialRecord(openai);
    return { env: { OPENAI_API_KEY: token.token.token }, cleanupOnFailure: null, cleanupOnExit: null };
  };
}
