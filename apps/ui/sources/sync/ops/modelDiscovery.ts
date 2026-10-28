import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
    isDynamicModelProbeCacheFresh,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheTransientSuccess,
    type DynamicModelProbeCacheEntry,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

/** Shared discovery lifecycle for model pickers and voice catalog requests. */
export async function discoverMachineModels(params: Readonly<{
    cacheKey: string;
    agentType: AgentId;
    machineId: string;
    serverId?: string | null;
    backendTarget: BackendTargetRefV1;
    capabilityParams: Readonly<Record<string, unknown>>;
    bypassCache?: boolean;
}>): Promise<DynamicModelProbeCacheEntry | null> {
    const cached = readDynamicModelProbeCache(params.cacheKey);
    if (!params.bypassCache && isDynamicModelProbeCacheFresh(cached)) return cached;

    return runDynamicModelProbeDedupe(params.cacheKey, async () => {
        try {
            const response = await machineCapabilitiesInvoke(params.machineId, {
                id: `cli.${params.agentType}`,
                method: 'probeModels',
                params: {
                    ...params.capabilityParams,
                    backendTarget: params.backendTarget,
                    ...(params.bypassCache ? { bypassCache: true } : {}),
                },
            }, { ...(params.serverId ? { serverId: params.serverId } : {}) });
            if (response.supported && response.response.ok) {
                const result = response.response.result;
                const parsed = parsePreflightModelListFromProbeModelsResult(result);
                if (parsed && result && typeof result === 'object' && !Array.isArray(result)) {
                    const record = result as Record<string, unknown>;
                    const previous = readDynamicModelProbeCache(params.cacheKey);
                    const previousList = previous?.kind === 'success' ? previous.value : null;
                    const list = previousList && stableJsonStringify(previousList) === stableJsonStringify(parsed) ? previousList : parsed;
                    const failed = record.refreshError === true || (record.source === 'static' && record.refreshError !== false);
                    const observedAt = typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
                        ? record.observedAt : Date.now();
                    if (!failed) {
                        if (record.cacheable === false) {
                            writeDynamicModelProbeCacheTransientSuccess(params.cacheKey, list, observedAt);
                        } else {
                            writeDynamicModelProbeCacheSuccess(params.cacheKey, list, observedAt);
                        }
                        return readDynamicModelProbeCache(params.cacheKey);
                    }
                    if (!previousList || (record.source !== 'static' && typeof record.observedAt === 'number' && previous?.kind === 'success' && record.observedAt > previous.updatedAt)) {
                        // A daemon can retain a real last-good observation after failure. A static fallback
                        // is display-only and must never acquire a successful-observation timestamp.
                        writeDynamicModelProbeCacheTransientSuccess(params.cacheKey, list, observedAt, record.source === 'static' || typeof record.observedAt !== 'number');
                    }
                }
            }
        } catch {
            // Transport failures are visible through the resource error state, including retained data.
        }
        writeDynamicModelProbeCacheError(params.cacheKey);
        return readDynamicModelProbeCache(params.cacheKey);
    });
}
