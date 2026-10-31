import { buildCodexAgentRuntimeDescriptor, readSessionMetadataRuntimeDescriptor, resolvePersistedCodexRuntimeIdentity } from '@happier-dev/agents';
import { DirectSessionsSourceSchema } from '@happier-dev/protocol';

import type { ExistingSessionHandoffStateResolver } from '@/backends/types';
import { resolveExistingCodexIndexedRolloutPath } from '@/backends/codex/connectedServices/reconcileCodexResumeRolloutPath';
import { resolveConfiguredCodexSqliteHome } from '@/backends/codex/connectedServices/codexStateFileNames';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { normalizeCodexVendorResumeId } from '@/backends/codex/utils/codexSessionFiles';
import { ExistingSessionStateUnavailableError } from '@/session/handoff/sessionHandoffErrors';

export const resolveExistingCodexSessionHandoffState: ExistingSessionHandoffStateResolver = async (params) => {
  const vendorResumeId = normalizeCodexVendorResumeId(params.vendorResumeId);
  if (!vendorResumeId || !await resolveExistingCodexIndexedRolloutPath({ env: params.env, vendorResumeId, cwd: params.targetPath })) {
    throw new ExistingSessionStateUnavailableError('Codex existing native session is unreachable through its index');
  }
  const codexHome = resolveConfiguredCodexHome(params.env);
  const sqliteHome = resolveConfiguredCodexSqliteHome(params.env, params.targetPath);
  const descriptor = readSessionMetadataRuntimeDescriptor(params.metadata, 'codex');
  const directSession = params.metadata.directSessionV1;
  const parsedSource = directSession && typeof directSession === 'object' && 'source' in directSession
    ? DirectSessionsSourceSchema.safeParse(directSession.source)
    : null;
  const sourceAffinity = parsedSource?.success && parsedSource.data.kind === 'codexHome' ? parsedSource.data : null;
  const home = descriptor?.home ?? sourceAffinity?.home ?? 'user';
  const connectedAffinity = home === 'connectedService'
    ? {
      connectedServiceId: descriptor?.connectedServiceId ?? (sourceAffinity?.home === 'connectedService' ? sourceAffinity.connectedServiceId : undefined),
      connectedServiceProfileId: descriptor?.connectedServiceProfileId ?? (sourceAffinity?.home === 'connectedService' ? sourceAffinity.connectedServiceProfileId : undefined),
      connectedServiceGroupId: descriptor?.connectedServiceGroupId ?? (sourceAffinity?.home === 'connectedService' ? sourceAffinity.connectedServiceGroupId : undefined),
    }
    : {};
  const backendMode = resolvePersistedCodexRuntimeIdentity(params.metadata)?.backendMode ?? 'appServer';
  return {
    remoteSessionId: vendorResumeId,
    directSource: { kind: 'codexHome', home, homePath: codexHome, ...connectedAffinity },
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({ backendMode, vendorSessionId: vendorResumeId, home, homePath: codexHome, sqliteHomePath: sqliteHome, ...connectedAffinity }),
    resume: {
      directory: params.targetPath,
      agent: 'codex',
      resume: vendorResumeId,
      environmentVariables: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome },
      transcriptStorage: params.sessionStorageMode,
      approvedNewDirectoryCreation: true,
      codexBackendMode: backendMode,
    },
  };
};
