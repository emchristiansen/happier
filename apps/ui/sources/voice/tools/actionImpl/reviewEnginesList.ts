import { AGENT_IDS } from '@/agents/catalog/catalog';
import { resolveBuiltInAgentTitle } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { storage } from '@/sync/domains/state/storage';
import { buildAvailableReviewEngineOptions } from '@/sync/domains/reviews/reviewEngineCatalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

/**
 * The catalog name the app already shows for a backend ("Factory Droid", not "Droid").
 * Native review engines are not catalog agents, so they keep their own protocol title.
 */
function resolveAgentLabel(agentId: string): string {
  return resolveBuiltInAgentTitle(agentId) ?? agentId;
}

export async function listReviewEnginesForVoiceTool(params: Readonly<{ sessionId: string; includeDisabled?: boolean }>): Promise<unknown> {
  const sessionId = normalizeId(params.sessionId);
  if (!sessionId) {
    return { ok: false, errorCode: 'session_not_selected', errorMessage: 'session_not_selected' };
  }

  const state: any = storage.getState();
  const session = state?.sessions?.[sessionId] ?? null;
  const machineId = normalizeId(readMachineTargetForSession(sessionId)?.machineId) || normalizeId(session?.metadata?.machineId);
  const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
  const machineCapabilitiesState = machineId ? getMachineCapabilitiesSnapshot(machineId, serverId) : null;
  const executionRunsBackends = extractExecutionRunsBackendsFromMachineCapabilitiesState(
    machineCapabilitiesState ? { snapshot: machineCapabilitiesState } : null,
  );

  const backendEnabledByTargetKey: Record<string, boolean> | null | undefined = state?.settings?.backendEnabledByTargetKey ?? null;
  const includeDisabled = params.includeDisabled === true;
  const agentIds = includeDisabled
    ? Array.from(AGENT_IDS)
    : Array.from(AGENT_IDS).filter((id) => backendEnabledByTargetKey?.[buildBackendTargetKey({ kind: 'builtInAgent', agentId: id })] !== false);
  const items = buildAvailableReviewEngineOptions({
    enabledAgentIds: agentIds,
    executionRunsBackends,
    resolveAgentLabel,
  })
    .map((item) => ({
      engineId: item.id,
      label: item.label,
      enabled: item.disabled !== true && backendEnabledByTargetKey?.[buildBackendTargetKey({ kind: 'builtInAgent', agentId: item.id })] !== false,
    }))
    .filter((item) => includeDisabled || item.enabled);

  return { sessionId, items };
}
