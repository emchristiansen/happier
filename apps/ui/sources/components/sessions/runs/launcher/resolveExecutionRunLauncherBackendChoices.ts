import { buildBackendTargetKey, type AcpCatalogSettingsV1, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { isAgentId } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries, resolveBuiltInAgentIdForBackendTarget, resolveBuiltInAgentTitle } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildAvailableReviewEngineOptions, type ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

export type ExecutionRunLauncherBackendChoice = Readonly<{
    target: BackendTargetRefV1;
    targetKey: string;
    builtInAgentId: string;
    title: string;
    disabled: boolean;
}>;

export function resolveExecutionRunLauncherBackendChoices(params: Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    intent: string;
}>): readonly ExecutionRunLauncherBackendChoice[] {
    const catalogAgentIds = Array.from(
        new Set([
            ...params.enabledAgentIds,
            ...Object.keys(params.executionRunsBackends ?? {}),
        ]),
    ).filter(isAgentId);
    const availableBuiltInBackendIds = new Set(
        resolveExecutionRunAvailableBackends(params.executionRunsBackends, params.intent),
    );

    if (params.intent === 'review') {
        return buildAvailableReviewEngineOptions({
            enabledAgentIds: [...params.enabledAgentIds],
            executionRunsBackends: params.executionRunsBackends,
            resolveAgentLabel: (id) => resolveBuiltInAgentTitle(id) ?? id,
        }).map((option) => {
            const target: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: option.id };
            return {
                target,
                targetKey: buildBackendTargetKey(target),
                builtInAgentId: option.id,
                title: option.label || option.id,
                disabled: option.disabled === true,
            };
        });
    }

    return getResolvedBackendCatalogEntries({
        enabledAgentIds: catalogAgentIds,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
    }).map((entry) => {
        const builtInAgentId = resolveBuiltInAgentIdForBackendTarget(entry.target);
        return {
            target: entry.target,
            targetKey: entry.targetKey,
            builtInAgentId,
            title: entry.title,
            disabled: !availableBuiltInBackendIds.has(builtInAgentId),
        };
    });
}
