import { describe, expect, it, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { recordTurnLifecycleProviderActivity, type TurnLifecycleProviderActivityAdmission } from '@/daemon/connectedServices/recovery/providerActivityProofRecorder';
import { applyTrackedSessionTurnLifecycle } from '@/daemon/sessions/applyTrackedSessionTurnLifecycle';
import type { TrackedSession } from '@/daemon/types';

import type { EnhancedMode } from '../loop';
import { Session } from '../session';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { surfaceClaudeAgentSdkResultFailure } from './surfaceClaudeAgentSdkResultFailure';

type CreateQuery = NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;
type LifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

/**
 * Real composed path: Agent SDK result -> claudeRemoteAgentSdk -> Session task markers ->
 * SessionTurnLifecycle -> daemon applyTrackedSessionTurnLifecycle -> provider-activity admission.
 * Only the session transport and the daemon's marker-file write are stubbed.
 */
function createComposedHarness() {
    const sessionId = 'happier-session';
    const terminals: Array<Readonly<{ turnId?: string; terminalStatus?: string }>> = [];
    const admissions: Array<Readonly<{ event: LifecycleEvent; terminalStatus?: string; turnId?: string; admission: TurnLifecycleProviderActivityAdmission }>> = [];
    const proofs: unknown[] = [];
    const tracked = { startedBy: 'daemon', happySessionId: sessionId, pid: 4242 } as TrackedSession;
    let daemonChain: Promise<void> = Promise.resolve();
    const lifecycle = createSessionTurnLifecycle({
        sessionId,
        enqueueSessionTurn: async () => {},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            if (event === 'assistant_message_end') terminals.push({ turnId, terminalStatus });
            daemonChain = daemonChain.then(async () => {
                const turnLifecycle = await applyTrackedSessionTurnLifecycle({
                    trackedSessions: [tracked], sessionId, event,
                    ...(turnId ? { turnId } : {}),
                    updateSessionMarkerActiveTurn: async () => true,
                });
                const admission = await recordTurnLifecycleProviderActivity({
                    sessionId, event,
                    ...(terminalStatus ? { terminalStatus } : {}),
                    turnLifecycle,
                    resolveRecoveryIdentities: () => [],
                    record: async (input) => { proofs.push(input); },
                });
                admissions.push({ event, terminalStatus, turnId, admission });
            });
        },
    });
    const client = {
        sessionId,
        sessionTurnLifecycle: lifecycle,
        rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        // Same marker routing as ApiSessionClient.sendAgentMessage.
        sendAgentMessage: vi.fn((provider, body) => {
            void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
        }),
        sendAgentMessageCommitted: vi.fn(async () => {}),
        keepAlive: vi.fn(),
        getMetadataSnapshot: () => null,
        waitForMetadataUpdate: vi.fn(async () => false),
        waitForProviderInputAdmission: async (signal: AbortSignal) => !signal.aborted,
        waitForPendingEligibilityUpdate: vi.fn(async () => false),
        popPendingMessage: vi.fn(async () => false),
        peekActionablePendingMessageQueueV2Count: vi.fn(async () => 0),
        discardPendingMessageQueueV2All: vi.fn(async () => 0),
        discardCommittedMessageLocalIds: vi.fn(async () => 0),
        updateMetadata: vi.fn(),
        updateAgentStateRequestSettlement: vi.fn(async () => {}),
        updateAgentState: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        on: vi.fn(),
        off: vi.fn(),
    } as unknown as SessionClientPort;
    const session = new Session({
        client, path: '/tmp', logPath: '/tmp/log', sessionId: null,
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
        onModeChange: () => {}, hookSettingsPath: '/tmp/hooks.json',
    });
    const onResultBoundCompletion = vi.fn();
    return {
        lifecycle, terminals, admissions, proofs, tracked, onResultBoundCompletion,
        settleDaemon: async () => { await daemonChain; },
        runnerCallbacks: {
            onThinkingChange: session.onThinkingChange,
            onResultBoundCompletion,
            onResultFailure: async (failure: string, kind?: 'provider_api_error' | 'execution_error') => {
                await surfaceClaudeAgentSdkResultFailure({ session: client as never, failure, kind });
            },
        },
    };
}

function startRunner(params: Readonly<{
    harness: ReturnType<typeof createComposedHarness>;
    createQuery: CreateQuery;
    prompts: readonly string[];
    inputFinished: Promise<void>;
}>) {
    const prompts = [...params.prompts];
    const allowNext: Array<() => void> = [];
    const gates = prompts.map((_, index) => index === 0 ? Promise.resolve() : new Promise<void>((resolve) => { allowNext.push(resolve); }));
    let index = 0;
    const runner = claudeRemoteAgentSdk({
        sessionId: null, transcriptPath: null, path: '/tmp', claudeArgs: [], claudeExecutablePath: '/tmp/claude',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
        nextMessage: async () => {
            const current = index++;
            const prompt = prompts[current];
            if (prompt === undefined) {
                await params.inputFinished;
                return null;
            }
            await Promise.race([gates[current], params.inputFinished]);
            return { message: prompt, mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
        },
        onReady: () => {}, onSessionFound: () => {}, onMessage: () => {},
        createQuery: params.createQuery,
        ...params.harness.runnerCallbacks,
    } as Parameters<typeof claudeRemoteAgentSdk>[0]);
    return { runner, releaseNextPrompt: () => allowNext.shift()?.() };
}

const apiError429 = {
    type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
    session_id: 'owned-session', result: "You've hit your limit", num_turns: 1,
} as const;

describe('claudeRemoteAgentSdk result turn ownership (composed through daemon admission)', () => {
    it('leaves a newer turn untouched by stale results of an earlier turn and admits only its own genuine result', async () => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        let releaseStale!: () => void;
        const staleReady = new Promise<void>((resolve) => { releaseStale = resolve; });
        let releaseGenuine!: () => void;
        const genuineReady = new Promise<void>((resolve) => { releaseGenuine = resolve; });
        let reachedSecondPrompt = false;
        let reachedStaleEnd = false;
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
                const first = await input.next();
                if (first.done) throw new Error('Expected first prompt');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'A done', user_message_uuid: first.value.uuid };
                const second = await Promise.race([input.next(), inputFinished.then(() => null)]);
                if (!second || second.done) return;
                reachedSecondPrompt = true;
                await staleReady;
                // Resume replay of A's API-error result, and a late result attributed to A.
                yield { ...apiError429, isReplay: true };
                // A replayed SUCCESS naming B's prompt is still a replay: not B's own result.
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'replayed', isReplay: true, user_message_uuid: second.value.uuid };
                yield { ...apiError429, user_message_uuid: first.value.uuid };
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'late A', user_message_uuid: first.value.uuid };
                reachedStaleEnd = true;
                await genuineReady;
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'B done', user_message_uuid: second.value.uuid };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner, releaseNextPrompt } = startRunner({ harness, createQuery, prompts: ['A', 'B'], inputFinished });
        void runner.catch(() => {});
        try {
            await vi.waitFor(async () => {
                await harness.settleDaemon();
                expect(harness.terminals).toHaveLength(1);
            });
            const turnA = harness.terminals[0]!;
            expect(turnA.terminalStatus).toBe('completed');
            expect(harness.onResultBoundCompletion).toHaveBeenCalledTimes(1);
            releaseNextPrompt();
            await vi.waitFor(() => { expect(reachedSecondPrompt).toBe(true); expect(harness.lifecycle.hasActiveTurn()).toBe(true); });
            const turnB = harness.lifecycle.getActiveTurnId();
            expect(turnB).not.toBe(turnA.turnId);
            const proofsBeforeStale = harness.proofs.length;

            releaseStale();
            await vi.waitFor(() => { expect(reachedStaleEnd).toBe(true); });
            await new Promise((resolve) => setTimeout(resolve, 20));
            await harness.settleDaemon();
            // (a) A's stale results neither complete nor fail B, and prove nothing.
            expect(harness.lifecycle.getActiveTurnId()).toBe(turnB);
            expect(harness.terminals).toHaveLength(1);
            expect(harness.proofs).toHaveLength(proofsBeforeStale);
            // Replayed and older-prompt results never mark a result-bound completion.
            expect(harness.onResultBoundCompletion).toHaveBeenCalledTimes(1);

            releaseGenuine();
            await vi.waitFor(async () => {
                await harness.settleDaemon();
                expect(harness.terminals).toHaveLength(2);
            });
            // (b) B's own genuine result completes B and is admitted as exact-turn provider activity.
            expect(harness.terminals[1]).toEqual({ turnId: turnB, terminalStatus: 'completed' });
            expect(harness.admissions.at(-1)?.admission).toEqual({ admitted: true, turnOwnership: 'exact_turn' });
            expect(harness.proofs).toHaveLength(proofsBeforeStale + 1);
            expect(harness.onResultBoundCompletion).toHaveBeenCalledTimes(2);
        } finally {
            releaseNextPrompt(); releaseStale(); releaseGenuine(); finishInput();
            await runner.catch(() => {});
        }
    });

    it('fails the active turn for its own API-error result without admitting provider activity', async () => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const first = await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
                if (first.done) throw new Error('Expected prompt');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { ...apiError429, user_message_uuid: first.value.uuid };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner } = startRunner({ harness, createQuery, prompts: ['A'], inputFinished });
        void runner.catch(() => {});
        try {
            await vi.waitFor(async () => {
                await harness.settleDaemon();
                expect(harness.terminals).toHaveLength(1);
            });
            // (c)
            expect(harness.terminals[0]?.terminalStatus).toBe('failed');
            expect(harness.lifecycle.hasActiveTurn()).toBe(false);
            expect(harness.proofs).toHaveLength(0);
            expect(harness.onResultBoundCompletion).not.toHaveBeenCalled();
        } finally {
            finishInput();
            await runner.catch(() => {});
        }
    });

    it.each(['error_max_turns', 'error_during_execution'] as const)('never publishes a completed terminal before a %s failure', async (subtype) => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const first = await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
                if (first.done) throw new Error('Expected prompt');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield {
                    type: 'result', subtype, is_error: true, session_id: 'owned-session',
                    errors: ['provider failed'], user_message_uuid: first.value.uuid,
                };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner } = startRunner({ harness, createQuery, prompts: ['A'], inputFinished });
        await expect(runner).rejects.toThrow(subtype);
        await harness.settleDaemon();
        // (d)
        expect(harness.terminals.map((terminal) => terminal.terminalStatus)).toEqual(['failed']);
        expect(harness.proofs).toHaveLength(0);
        expect(harness.onResultBoundCompletion).not.toHaveBeenCalled();
        finishInput();
    });

    it('completes on an unattributed (older-producer) result without marking it result-bound', async () => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const first = await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
                if (first.done) throw new Error('Expected prompt');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'no attribution' };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner } = startRunner({ harness, createQuery, prompts: ['A'], inputFinished });
        void runner.catch(() => {});
        try {
            await vi.waitFor(async () => {
                await harness.settleDaemon();
                expect(harness.terminals).toHaveLength(1);
            });
            // Disclosed fallback: the turn still completes, but it is never qualified as result-bound work.
            expect(harness.terminals[0]?.terminalStatus).toBe('completed');
            expect(harness.onResultBoundCompletion).not.toHaveBeenCalled();
        } finally {
            finishInput();
            await runner.catch(() => {});
        }
    });
});
