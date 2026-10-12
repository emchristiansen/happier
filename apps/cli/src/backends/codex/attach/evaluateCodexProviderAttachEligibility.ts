import type { ProviderAttachEligibility } from '@/backends/types';
import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
} from '@happier-dev/agents';

export function evaluateCodexProviderAttachEligibility(params: Readonly<{
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  hasLocalAttachmentInfo: boolean;
  hasLocalSharedControlEndpoint?: boolean;
}>): ProviderAttachEligibility {
  if (resolvePersistedCodexRuntimeIdentity(params.metadata)?.backendMode !== 'appServer') {
    return { eligible: false, reason: 'Codex native attach is only available for App Server sessions.' };
  }
  if (!resolvePersistedCodexVendorSessionId(params.metadata)) {
    return { eligible: false, reason: 'Session does not include a Codex thread id.' };
  }
  if (typeof params.metadata.path !== 'string' || params.metadata.path.trim().length === 0) {
    return { eligible: false, reason: 'Session metadata is missing a working directory path.' };
  }
  const sameMachine = Boolean(
    params.currentMachineId
    && params.sessionMachineId
    && params.currentMachineId === params.sessionMachineId,
  );
  if (!sameMachine && !params.hasLocalAttachmentInfo && !params.hasLocalSharedControlEndpoint) {
    return { eligible: false, reason: 'Codex shared-control sockets can only be attached on the session machine.' };
  }
  return { eligible: true, scope: 'local', metadata: params.metadata };
}
