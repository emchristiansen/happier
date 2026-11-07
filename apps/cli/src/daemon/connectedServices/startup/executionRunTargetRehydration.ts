import type { CatalogAgentId } from '@/backends/types';
import { ExecutionRunRetentionPolicySchema, type ExecutionRunRetentionPolicy } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ExecutionRunConnectedServicesLaunchV1Schema } from '../runsBridge/contract';

type CandidateMarker = Readonly<{
  runId: string;
  happySessionId: string;
  pid: number;
  status: unknown;
  finishedAtMs?: unknown;
  retentionPolicy?: unknown;
  executionRunConnectedServicesLaunchV1?: unknown;
}>;

/**
 * Rebuild only the daemon-local distribution index for execution runs whose runner liveness is
 * independently proven. This function deliberately has no launch/resume/prompt/queue dependency:
 * persisted markers describe identity but never grant execution authority.
 */
export async function rehydrateLiveExecutionRunRuntimeTargets(input: Readonly<{
  markers: readonly CandidateMarker[] | (() => Promise<readonly CandidateMarker[]>);
  runtimeRegistry: ConnectedServiceRuntimeRegistry;
  proveRunnerLive: (marker: CandidateMarker) => boolean | Promise<boolean>;
  adoptCleanup: (input: Readonly<{
    runId: string;
    runKey: string;
    pid: number;
    agentId: CatalogAgentId;
    materializedRoot: string;
    retentionPolicy?: ExecutionRunRetentionPolicy | null;
  }>) => boolean;
}>): Promise<Readonly<{ registeredRunIds: string[]; inactiveRunIds: string[] }>> {
  const markers = typeof input.markers === 'function' ? await input.markers() : input.markers;
  const parsed = markers.map((marker) => ({
    marker,
    launch: ExecutionRunConnectedServicesLaunchV1Schema.safeParse(marker.executionRunConnectedServicesLaunchV1),
  }));
  const runKeyCounts = new Map<string, number>();
  for (const candidate of parsed) {
    if (candidate.launch.success) {
      const key = candidate.launch.data.runKey;
      runKeyCounts.set(key, (runKeyCounts.get(key) ?? 0) + 1);
    }
  }

  const registeredRunIds: string[] = [];
  const inactiveRunIds: string[] = [];
  for (const candidate of parsed) {
    const { marker } = candidate;
    const isRunning = marker.status === 'running' && typeof marker.finishedAtMs !== 'number';
    const unambiguous = candidate.launch.success
      && runKeyCounts.get(candidate.launch.data.runKey) === 1;
    if (!isRunning || !unambiguous || !(await input.proveRunnerLive(marker))) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    if (!candidate.launch.success) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    const launch = candidate.launch.data;
    if (launch.materializedRoot && !input.adoptCleanup({
      runId: marker.runId,
      runKey: launch.runKey,
      pid: marker.pid,
      agentId: launch.agentId,
      materializedRoot: launch.materializedRoot,
      retentionPolicy: (() => {
        const parsed = ExecutionRunRetentionPolicySchema.safeParse(marker.retentionPolicy);
        return parsed.success ? parsed.data : null;
      })(),
    })) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    input.runtimeRegistry.registerRunTarget({
      runKey: launch.runKey,
      pid: marker.pid,
      agentId: launch.agentId,
      sessionId: marker.happySessionId,
      connectedServicesBindingsRaw: launch.connectedServicesBindings,
      connectedServiceSelectionsEnv: launch.connectedServiceSelectionsJson
        ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: launch.connectedServiceSelectionsJson }
        : null,
      materializationKey: launch.runKey,
      ...(launch.brokerSelectionIdentity ? { brokerSelectionIdentity: launch.brokerSelectionIdentity } : {}),
      runtimeAccountIdentitySelections: launch.runtimeAccountIdentitySelections,
      sessionDirectory: launch.sessionDirectory ?? null,
    });
    registeredRunIds.push(marker.runId);
  }
  return { registeredRunIds, inactiveRunIds };
}
