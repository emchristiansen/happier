import { isSessionOwnedActivityUnobserved } from '../attention/deriveSessionRuntimePresentationState';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { deriveExecutionRunSubagents } from './executionRuns/deriveExecutionRunSubagents';
import { deriveProviderSessionSubagents } from './providers';
import { deriveSubAgentSidechainSubagents } from './subAgentSidechains/deriveSubAgentSidechainSubagents';
import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from './types';

function sortSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagent[] {
    return [...subagents].sort((left, right) => {
        const leftRunning = left.isActive !== false && left.status === 'running' ? 0 : 1;
        const rightRunning = right.isActive !== false && right.status === 'running' ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;

        const leftUpdated = left.timestamps.updatedAtMs ?? 0;
        const rightUpdated = right.timestamps.updatedAtMs ?? 0;
        if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;

        return left.id.localeCompare(right.id);
    });
}

export function deriveSessionSubagents(params: Readonly<{
    session: Readonly<{ metadata?: Readonly<{ flavor?: unknown }> | null }>;
    messages: readonly Message[];
    runtimeLostSinceMs?: number | null;
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
}>): readonly SessionSubagent[] {
    const flavor = typeof (params.session as any)?.metadata?.flavor === 'string'
        ? String((params.session as any).metadata.flavor)
        : null;

    const executionRuns = deriveExecutionRunSubagents({
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    });
    const providerSubagents = deriveProviderSessionSubagents({
        flavor,
        messages: params.messages,
    });
    const excludedSidechainIds = new Set<string>();
    for (const subagent of [...executionRuns, ...providerSubagents]) {
        const sidechainId = subagent.transcript.sidechainId;
        if (sidechainId) excludedSidechainIds.add(sidechainId);
    }
    const genericSubagentSidechains = deriveSubAgentSidechainSubagents({
        messages: params.messages,
        flavor,
        excludedSidechainIds,
    });

    return sortSubagents([
        ...executionRuns,
        ...providerSubagents,
        ...genericSubagentSidechains,
    ].map((subagent) => subagent.kind !== 'execution_run' && subagent.status === 'running'
        && isSessionOwnedActivityUnobserved(params.runtimeLostSinceMs, subagent.timestamps.updatedAtMs)
        ? { ...subagent, status: 'unknown' as const }
        : subagent));
}
