export type SubagentMetadata = Readonly<{
    threadId: string;
    providerTurnId?: string | null;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>;

// Managed app-server turns have exact occurrence IDs; external rollout projections retain their thread-only contract.
export function resolveCodexSubagentOccurrenceId(metadata: Readonly<{ threadId: string; providerTurnId?: string | null }>): string {
    return metadata.providerTurnId ? JSON.stringify([metadata.threadId, metadata.providerTurnId]) : metadata.threadId;
}

export function buildCodexSyntheticSubagentToolCall(metadata: SubagentMetadata) {
    return {
        type: 'tool-call' as const,
        callId: resolveCodexSubagentOccurrenceId(metadata),
        name: 'SubAgent',
        input: {
            threadId: metadata.threadId,
            ...(metadata.providerTurnId ? { providerTurnId: metadata.providerTurnId, sidechainId: resolveCodexSubagentOccurrenceId(metadata) } : {}),
            ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
            ...(metadata.nickname ? { nickname: metadata.nickname } : {}),
            ...(metadata.role ? { role: metadata.role } : {}),
        },
        id: resolveCodexSubagentOccurrenceId(metadata),
    };
}

export function buildCodexSyntheticSubagentToolResult(metadata: Readonly<{
    threadId: string;
    providerTurnId?: string | null;
    status: 'completed' | 'failed' | 'interrupted';
    error?: string;
}>) {
    return {
        type: 'tool-result' as const,
        callId: resolveCodexSubagentOccurrenceId(metadata),
        output: {
            status: metadata.status,
            threadId: metadata.threadId,
            ...(metadata.providerTurnId ? { providerTurnId: metadata.providerTurnId, sidechainId: resolveCodexSubagentOccurrenceId(metadata) } : {}),
            ...(metadata.error ? { error: metadata.error } : {}),
        },
        id: `${resolveCodexSubagentOccurrenceId(metadata)}:${metadata.status}`,
        ...(metadata.status !== 'completed' ? { isError: true as const } : {}),
    };
}
