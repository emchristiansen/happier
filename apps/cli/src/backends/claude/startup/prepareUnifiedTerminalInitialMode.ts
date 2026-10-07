import type { Metadata } from '@/api/types';
import type { EnhancedMode } from '../loop';
import type { ClaudeModelEffortLevelsTracker } from '../models/claudeModelEffortLevelsTracker';
import {
    resolveClaudeInstalledRuntimeSessionOptions,
    type ClaudeInstalledRuntimeCapabilities,
} from '../sessionControls/probeClaudeInstalledRuntimeCapabilities';
import { adoptReasoningEffortOverrideFromMetadata } from '../utils/adoptReasoningEffortOverrideFromMetadata';

/** Refresh the initial terminal mode at the session-readiness boundary, before native launch. */
export async function prepareClaudeUnifiedTerminalInitialMode(params: Readonly<{
    initialMode: EnhancedMode;
    modelEffortTracker: ClaudeModelEffortLevelsTracker;
    modelId: unknown;
    getMetadataSnapshot: () => Metadata | null | undefined;
    readReasoningEffortState: () => Readonly<{ value: string | undefined; updatedAt: number }>;
    installedRuntimeCapabilities: ClaudeInstalledRuntimeCapabilities;
}>): Promise<Readonly<{
    modelId: string;
    reasoningEffort: string | undefined;
    reasoningEffortUpdatedAt: number;
}>> {
    const modelId = typeof params.modelId === 'string' ? params.modelId.trim() : '';
    await params.modelEffortTracker.refresh(modelId);
    params.initialMode.model = modelId || undefined;
    params.initialMode.modelEffortLevels = params.modelEffortTracker.getLevels();
    params.initialMode.modelEffortLevelsModelId = params.modelEffortTracker.getModelId();
    // Empty Resume has no user message to seed its launch controls. Read the same durable
    // intent and timestamp state as the message path after capability evidence has settled.
    const current = params.readReasoningEffortState();
    const adopted = adoptReasoningEffortOverrideFromMetadata({
        currentValueId: current.value ?? null,
        currentUpdatedAt: current.updatedAt,
        metadata: params.getMetadataSnapshot(),
    });
    const reasoningEffort = adopted.valueId ?? undefined;
    params.initialMode.reasoningEffort = resolveClaudeInstalledRuntimeSessionOptions(
        { reasoningEffort },
        params.installedRuntimeCapabilities,
    ).reasoningEffort;
    return {
        modelId,
        reasoningEffort,
        reasoningEffortUpdatedAt: adopted.updatedAt,
    };
}
