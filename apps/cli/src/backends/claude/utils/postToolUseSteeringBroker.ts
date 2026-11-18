import { isLivePrimaryClaudeProviderHook, readSessionHookEventName } from './sessionHookAttribution';
import type { SessionHookData, SessionHookOutputContext } from './startHookServer';

/**
 * Outcome of one steering offer.
 *
 * - `written_to_hook_response`: a PostToolUse hook response carrying the message finished
 *   writing to its forwarder. This is not proof that Claude read it.
 * - `hook_response_lost`: a hook response took the message but closed before it finished
 *   writing. The message was not delivered through that response; it is retryable.
 * - `no_tool_boundary`: no capable hook response took the message before the caller's
 *   deadline or cancellation. Nothing was delivered; it is retryable.
 */
export type PostToolUseSteerOutcome = 'written_to_hook_response' | 'hook_response_lost' | 'no_tool_boundary';

/** Messages taken by exactly one hook response. Settle with whether that response finished writing. */
export type TakenPostToolUseSteering = Readonly<{
    additionalContext: string;
    settle: (written: boolean) => void;
}>;

type WaitingOffer = {
    readonly message: string;
    readonly resolve: (outcome: PostToolUseSteerOutcome) => void;
    readonly release: () => void;
};

/**
 * Non-stalling rendezvous between steering callers and Claude PostToolUse hook responses.
 *
 * The caller's offer waits, never the hook: a hook response takes whatever offers are live at
 * that instant and answers immediately, so tool calls are never delayed waiting for a message.
 * An offer lives only for its caller's own deadline or cancellation; nothing is queued for later.
 * A taken offer is bound to that single response and is never handed to another response.
 * All live offers ride the same boundary, so an earlier uncertain message cannot strand later ones.
 */
export function createPostToolUseSteeringBroker() {
    let waiting: WaitingOffer[] = [];

    return {
        offer(params: Readonly<{ message: string; waitMs: number; signal?: AbortSignal }>): Promise<PostToolUseSteerOutcome> {
            if (params.signal?.aborted) return Promise.resolve('no_tool_boundary');
            return new Promise((resolve) => {
                const withdraw = () => {
                    if (!waiting.includes(entry)) return;
                    waiting = waiting.filter((candidate) => candidate !== entry);
                    entry.release();
                    resolve('no_tool_boundary');
                };
                const timer = setTimeout(withdraw, params.waitMs);
                const entry: WaitingOffer = {
                    message: params.message,
                    resolve,
                    release: () => {
                        clearTimeout(timer);
                        params.signal?.removeEventListener('abort', withdraw);
                    },
                };
                params.signal?.addEventListener('abort', withdraw, { once: true });
                waiting.push(entry);
            });
        },

        take(): TakenPostToolUseSteering | undefined {
            if (waiting.length === 0) return undefined;
            const taken = waiting;
            waiting = [];
            for (const entry of taken) entry.release();
            let settled = false;
            return {
                additionalContext: taken.map((entry) => entry.message).join('\n\n'),
                settle: (written) => {
                    if (settled) return;
                    settled = true;
                    for (const entry of taken) entry.resolve(written ? 'written_to_hook_response' : 'hook_response_lost');
                },
            };
        },
    };
}

export type PostToolUseSteeringBroker = ReturnType<typeof createPostToolUseSteeringBroker>;

/**
 * The PostToolUse hook-output producer. It binds live steering offers to this one response only
 * when the forwarder can pass JSON output to Claude, the hook belongs to the established primary
 * session, and the response is still open; it never waits.
 */
export function producePostToolUseSteeringOutput(params: Readonly<{
    broker: PostToolUseSteeringBroker;
    data: SessionHookData;
    context: SessionHookOutputContext;
    expectedSessionId: string | null;
}>): Record<string, unknown> | undefined {
    const { broker, data, context } = params;
    if (readSessionHookEventName(data) !== 'PostToolUse') return undefined;
    if (!context.outputCapable || context.signal.aborted) return undefined;
    // Steering requires a proven recipient: while the native primary identity is unknown (before
    // the first SessionStart or after a fork clears it), no hook can take a message.
    if (!params.expectedSessionId) return undefined;
    if (!isLivePrimaryClaudeProviderHook(data, params.expectedSessionId)) return undefined;
    const taken = broker.take();
    if (!taken) return undefined;
    void context.responseWritten.then(taken.settle);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: taken.additionalContext } };
}

/**
 * The Claude runner's single steering owner: the hook-output producer and the runtime control that
 * feeds it share one broker, so steering exists only where PostToolUse hook responses are served.
 */
export function createClaudeToolBoundarySteering(params: Readonly<{ readExpectedSessionId: () => string | null }>) {
    const broker = createPostToolUseSteeringBroker();
    return {
        produceSessionHookOutput: (_sessionId: string, data: SessionHookData, context: SessionHookOutputContext) =>
            producePostToolUseSteeringOutput({ broker, data, context, expectedSessionId: params.readExpectedSessionId() }),
        steerAtToolBoundary: (request: Readonly<{ message: string; waitMs: number; signal?: AbortSignal }>) =>
            broker.offer(request),
    };
}
