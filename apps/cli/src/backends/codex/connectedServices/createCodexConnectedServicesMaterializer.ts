import { join } from 'node:path';

import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { DEFAULT_MANIFEST_NAME, LEGACY_CODEX_MANIFEST_NAME } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { codexConnectedServiceStateSharingDescriptor } from './codexConnectedServiceStateSharingDescriptor';
import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';

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
      const materialized = await materializeCodexConnectedServiceAuth({
        rootDir: params.rootDir,
        previousCodexHome: params.previousMaterializedRoot
          ? join(params.previousMaterializedRoot, 'codex-home')
          : null,
        record: codex,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
      });

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
