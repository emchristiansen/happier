import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';

export type ClaudeAgentSdkResultFailureKind = 'provider_api_error' | 'execution_error';

/**
 * Fails the still-active turn for an Agent SDK result that ended it with an error, before the
 * runner releases it, so the release cannot record it completed. Idle sessions are not allocated
 * a turn: a usage-limit tap that already failed the turn leaves nothing to fail twice.
 */
export async function surfaceClaudeAgentSdkResultFailure(input: Readonly<{
    session: Readonly<{ sessionTurnLifecycle?: SessionTurnLifecycle }>;
    failure: string;
    kind?: ClaudeAgentSdkResultFailureKind;
    logDebug?: (message: string, error: unknown) => void;
}>): Promise<void> {
    const kind = input.kind ?? 'provider_api_error';
    await surfacePrimarySessionRuntimeIssue({
        provider: 'claude',
        cause: kind === 'provider_api_error' ? 'status_error' : 'session_error',
        error: {
            code: kind === 'provider_api_error' ? 'claude_agent_sdk_result_api_error' : 'claude_agent_sdk_result_error',
            message: input.failure,
        },
        session: input.session,
    }).catch((error) => {
        input.logDebug?.('[remote]: failed to surface Claude Agent SDK result turn failure (non-fatal)', error);
        return null;
    });
}
