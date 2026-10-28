import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import {
    buildCodexSyntheticSubagentToolCall,
    resolveCodexSubagentOccurrenceId,
    type SubagentMetadata,
    buildCodexSyntheticSubagentToolResult,
} from './buildCodexSyntheticSubagentToolMessages';

type SessionLike = Readonly<{
    sendAgentMessage: (
        provider: 'codex',
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
    sendAgentMessageCommitted: (
        provider: 'codex',
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<unknown>;
}>;

type SubagentOccurrenceState = Readonly<{
    rootToolCallSent: boolean;
    rootToolResultSent: boolean;
}>;

export function createCodexSyntheticSubagentTracker(params: Readonly<{
    session: SessionLike;
}>) {
    const stateByOccurrenceId = new Map<string, SubagentOccurrenceState>();

    const ensureStarted = async (
        metadata: SubagentMetadata,
        opts?: Readonly<{ localId: string }>,
    ): Promise<void> => {
        const current = stateByOccurrenceId.get(resolveCodexSubagentOccurrenceId(metadata));
        if (current?.rootToolCallSent) return;

        const body = buildCodexSyntheticSubagentToolCall(metadata);
        if (opts) {
            await params.session.sendAgentMessageCommitted('codex', body, opts);
        } else {
            params.session.sendAgentMessage('codex', body);
        }
        stateByOccurrenceId.set(resolveCodexSubagentOccurrenceId(metadata), {
            rootToolCallSent: true,
            rootToolResultSent: current?.rootToolResultSent ?? false,
        });
    };

    const finalize = async (
        metadata: Readonly<{ threadId: string; providerTurnId?: string | null; status: 'completed' | 'failed' | 'interrupted'; error?: string }>,
        opts?: Readonly<{ localId: string }>,
    ): Promise<void> => {
        const current = stateByOccurrenceId.get(resolveCodexSubagentOccurrenceId(metadata));
        if (!current?.rootToolCallSent) {
            if (opts) {
                throw new Error(`Exact Codex subagent result is missing its started occurrence: ${metadata.threadId}`);
            }
            await ensureStarted(metadata);
        }
        const latest = stateByOccurrenceId.get(resolveCodexSubagentOccurrenceId(metadata));
        if (latest?.rootToolResultSent) return;

        const body = buildCodexSyntheticSubagentToolResult(metadata);
        if (opts) {
            await params.session.sendAgentMessageCommitted('codex', body, opts);
        } else {
            params.session.sendAgentMessage('codex', body);
        }
        stateByOccurrenceId.set(resolveCodexSubagentOccurrenceId(metadata), {
            rootToolCallSent: true,
            rootToolResultSent: true,
        });
    };

    return {
        ensureStarted,
        finalize,

        hasStarted(threadId: string, providerTurnId?: string | null): boolean {
            return stateByOccurrenceId.get(resolveCodexSubagentOccurrenceId({ threadId, providerTurnId }))?.rootToolCallSent === true;
        },
    };
}
