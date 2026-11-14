// Only the daemon quota-snapshot delivery transport is replaced: it would otherwise write to a live daemon.
vi.mock('@/daemon/connectedServices/quotas/deliverConnectedServiceQuotaSnapshotToDaemon', () => ({
    deliverConnectedServiceQuotaSnapshotToDaemon: vi.fn(async () => ({ ok: true })),
}));
import { describe, expect, it, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { recordTurnLifecycleProviderActivity, type TurnLifecycleProviderActivityAdmission } from '@/daemon/connectedServices/recovery/providerActivityProofRecorder';
import { applyTrackedSessionTurnLifecycle } from '@/daemon/sessions/applyTrackedSessionTurnLifecycle';
import type { TrackedSession } from '@/daemon/types';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';

import type { EnhancedMode } from '../loop';
import { Session } from '../session';
import {
    recordClaudeRateLimitQuotaEvidence,
    surfaceClaudeRateLimitRuntimeIssue,
    surfaceClaudeRuntimeAuthFailure,
} from '../connectedServices/surfaceClaudeRuntimeIssues';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { surfaceClaudeAgentSdkResultFailure } from './surfaceClaudeAgentSdkResultFailure';

type CreateQuery = NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;
type LifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

/**
 * Real composed path: Agent SDK frames -> claudeRemoteAgentSdk -> the remote launcher's runner
 * callbacks (same calls and arguments as claudeRemoteLauncher's Agent SDK wiring) -> real Session ->
 * SessionTurnLifecycle -> daemon applyTrackedSessionTurnLifecycle -> provider-activity admission.
 * Only the provider query, the session transport and the daemon quota/marker writes are stubbed.
 */
function createComposedHarness() {
    const sessionId = 'happier-session';
    const terminals: Array<Readonly<{ turnId?: string; terminalStatus?: string }>> = [];
    const admissions: Array<Readonly<{ event: LifecycleEvent; terminalStatus?: string; turnId?: string; admission: TurnLifecycleProviderActivityAdmission }>> = [];
    const tracked = { startedBy: 'daemon', happySessionId: sessionId, pid: 4242 } as TrackedSession;
    let daemonChain: Promise<void> = Promise.resolve();
    const lifecycle = createSessionTurnLifecycle({
        sessionId,
        enqueueSessionTurn: async () => {},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            if (event === 'assistant_message_end') terminals.push({ turnId, terminalStatus });
            if (event === 'turn_cancelled') terminals.push({ turnId, terminalStatus: 'cancelled' });
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
                    record: async () => {},
                });
                admissions.push({ event, terminalStatus, turnId, admission });
            });
        },
    });
    const markResultBoundTurnCompletion = vi.fn();
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
        markResultBoundTurnCompletion,
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
    // Exactly the launcher's Agent SDK runner callbacks (claudeRemoteLauncher remote runner options).
    const launcherCallbacks = {
        onThinkingChange: session.onThinkingChange,
        onRateLimitEvent: async (
            details: NormalizedProviderUsageLimitDetailsV1,
            observedWindows: readonly NormalizedProviderUsageLimitDetailsV1[],
        ) => {
            await surfaceClaudeRateLimitRuntimeIssue(session, details, '[remote]', { observedWindows });
        },
        onQuotaEvidence: async (windows: readonly NormalizedProviderUsageLimitDetailsV1[]) => {
            await recordClaudeRateLimitQuotaEvidence(session, windows, '[remote]');
        },
        onRuntimeAuthFailureEvent: async (error: unknown) => {
            await surfaceClaudeRuntimeAuthFailure(session, error, '[remote]');
        },
        onResultFailure: async (failure: string, kind?: 'provider_api_error' | 'execution_error') => {
            await surfaceClaudeAgentSdkResultFailure({ session: session.client, failure, kind });
        },
        onResultBoundCompletion: () => {
            session.client.markResultBoundTurnCompletion?.('claude_sdk_result_bound_v1');
        },
    };
    return {
        lifecycle, terminals, admissions, session, markResultBoundTurnCompletion, launcherCallbacks,
        settleDaemon: async () => { await daemonChain; },
    };
}

type Harness = ReturnType<typeof createComposedHarness>;

function startTwoPromptRunner(params: Readonly<{ harness: Harness; createQuery: CreateQuery; inputFinished: Promise<void> }>) {
    const prompts = ['A', 'B'];
    let releaseB!: () => void;
    const gates = [Promise.resolve(), new Promise<void>((resolve) => { releaseB = resolve; })];
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
        ...params.harness.launcherCallbacks,
    } as Parameters<typeof claudeRemoteAgentSdk>[0]);
    void runner.catch(() => {});
    return { runner, releaseB };
}

function errorResult(status: 401 | 429, uuid: string | undefined, replay: boolean) {
    return {
        type: 'result', subtype: 'success', is_error: true, api_error_status: status,
        session_id: 'owned-session',
        result: status === 429 ? 'usage limit reached' : 'authentication_error',
        user_message_uuid: uuid,
        ...(replay ? { isReplay: true } : {}),
    };
}

describe('Agent SDK result ownership gates the launcher failure taps (SDK-1)', () => {
    it.each([
        { label: 'replayed-429', status: 429 as const, replay: true },
        { label: 'late-attributed-429', status: 429 as const, replay: false },
        { label: 'replayed-401', status: 401 as const, replay: true },
        { label: 'late-attributed-401', status: 401 as const, replay: false },
    ])('$label of A leaves active B untouched, then B completes from its own result', async ({ status, replay }) => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((r) => { finishInput = r; });
        let releaseStale!: () => void;
        const staleGate = new Promise<void>((r) => { releaseStale = r; });
        let releaseGenuine!: () => void;
        const genuineGate = new Promise<void>((r) => { releaseGenuine = r; });
        let reachedSecond = false;
        let reachedAfterStale = false;
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
                const first = await input.next(); if (first.done) throw Error('no first');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'A done', user_message_uuid: first.value.uuid };
                const second = await input.next(); if (second.done) throw Error('no second');
                reachedSecond = true;
                await staleGate;
                yield errorResult(status, first.value.uuid, replay);
                reachedAfterStale = true;
                await genuineGate;
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'B done', user_message_uuid: second.value.uuid };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner, releaseB } = startTwoPromptRunner({ harness, createQuery, inputFinished });
        try {
            await vi.waitFor(() => expect(harness.terminals).toHaveLength(1));
            releaseB();
            await vi.waitFor(() => {
                expect(reachedSecond).toBe(true);
                expect(harness.lifecycle.hasActiveTurn()).toBe(true);
            });
            const turnB = harness.lifecycle.getActiveTurnId();
            harness.markResultBoundTurnCompletion.mockClear();
            releaseStale();
            await vi.waitFor(() => expect(reachedAfterStale || !harness.lifecycle.hasActiveTurn()).toBe(true));
            await harness.settleDaemon();

            expect(harness.lifecycle.getActiveTurnId()).toBe(turnB);
            expect(harness.terminals.filter((t) => t.turnId === turnB)).toEqual([]);
            expect(harness.markResultBoundTurnCompletion).not.toHaveBeenCalled();

            releaseGenuine();
            await vi.waitFor(() => expect(harness.terminals.filter((t) => t.turnId === turnB)).toEqual([
                { turnId: turnB, terminalStatus: 'completed' },
            ]));
            expect(harness.markResultBoundTurnCompletion).toHaveBeenCalledTimes(1);
        } finally {
            releaseB(); releaseStale(); releaseGenuine(); finishInput();
            await runner.catch(() => {});
            harness.session.cleanup(); harness.lifecycle.dispose();
        }
    });

    it.each([429, 401] as const)('a genuine current %s result for B still fails B before any completed terminal', async (status) => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((r) => { finishInput = r; });
        let releaseCurrent!: () => void;
        const currentGate = new Promise<void>((r) => { releaseCurrent = r; });
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
                const first = await input.next(); if (first.done) throw Error('no first');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { type: 'result', subtype: 'success', session_id: 'owned-session', result: 'A done', user_message_uuid: first.value.uuid };
                const second = await input.next(); if (second.done) throw Error('no second');
                await currentGate;
                yield errorResult(status, second.value.uuid, false);
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as CreateQuery;
        const { runner, releaseB } = startTwoPromptRunner({ harness, createQuery, inputFinished });
        try {
            await vi.waitFor(() => expect(harness.terminals).toHaveLength(1));
            releaseB();
            await vi.waitFor(() => expect(harness.lifecycle.hasActiveTurn()).toBe(true));
            const turnB = harness.lifecycle.getActiveTurnId();
            harness.markResultBoundTurnCompletion.mockClear();
            releaseCurrent();
            await vi.waitFor(() => expect(harness.terminals.filter((t) => t.turnId === turnB).length).toBeGreaterThan(0));
            await harness.settleDaemon();
            const turnBTerminals = harness.terminals.filter((t) => t.turnId === turnB);
            expect(turnBTerminals[0]).toEqual({ turnId: turnB, terminalStatus: 'failed' });
            expect(turnBTerminals.some((t) => t.terminalStatus === 'completed')).toBe(false);
            expect(harness.markResultBoundTurnCompletion).not.toHaveBeenCalled();
        } finally {
            releaseB(); releaseCurrent(); finishInput();
            await runner.catch(() => {});
            harness.session.cleanup(); harness.lifecycle.dispose();
        }
    });
});

describe('a foreground turn ended without its own result publishes its real outcome (SDK-3)', () => {
    it.each([
        { kind: 'interrupt', expected: 'cancelled' },
        { kind: 'abort-error', expected: 'cancelled' },
        { kind: 'transport-error', expected: 'failed' },
        { kind: 'eof-before-result', expected: 'failed' },
    ] as const)('$kind publishes $expected and never completed', async ({ kind, expected }) => {
        const harness = createComposedHarness();
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((r) => { finishInput = r; });
        let triggerEnd!: () => void;
        const endGate = new Promise<void>((r) => { triggerEnd = r; });
        let interruptHandler: null | (() => Promise<void>) = null;
        let consumed = false;
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const first = await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
                if (first.done) throw Error('no prompt');
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                consumed = true;
                await endGate;
                if (kind === 'transport-error') throw Error('SDK transport closed before result');
                if (kind === 'abort-error') {
                    const { AbortError } = await import('@anthropic-ai/claude-agent-sdk');
                    throw new AbortError('aborted');
                }
                if (kind === 'interrupt') await inputFinished;
            },
            interrupt: async () => {},
            close() { finishInput(); triggerEnd(); },
        })) as unknown as CreateQuery;
        let sent = false;
        const runner = claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: process.env.TMPDIR ?? '/tmp', claudeArgs: [],
            claudeExecutablePath: '/nonexistent-test-provider',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
            nextMessage: async () => {
                if (!sent) {
                    sent = true;
                    return { message: 'A', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
                }
                await inputFinished;
                return null;
            },
            onReady: () => {}, onSessionFound: () => {}, onMessage: () => {}, createQuery,
            setTurnInterrupt: (handler) => { interruptHandler = handler; },
            ...harness.launcherCallbacks,
        } as Parameters<typeof claudeRemoteAgentSdk>[0]);
        void runner.catch(() => {});
        try {
            await vi.waitFor(() => {
                expect(consumed).toBe(true);
                expect(harness.lifecycle.hasActiveTurn()).toBe(true);
            });
            const turnA = harness.lifecycle.getActiveTurnId();
            if (kind === 'interrupt') {
                // Exact launcher doAbort order: await the registered interrupt, then abortCurrentTaskTurn.
                await interruptHandler!();
                harness.session.abortCurrentTaskTurn();
            } else {
                triggerEnd();
                await runner.catch(() => {});
            }
            await harness.settleDaemon();
            expect(harness.terminals.filter((t) => t.terminalStatus === 'completed')).toEqual([]);
            expect(harness.terminals.filter((t) => t.turnId === turnA)).toEqual([{ turnId: turnA, terminalStatus: expected }]);
            expect(harness.markResultBoundTurnCompletion).not.toHaveBeenCalled();
            expect(harness.lifecycle.hasActiveTurn()).toBe(false);
        } finally {
            triggerEnd(); finishInput();
            await runner.catch(() => {});
            harness.session.cleanup(); harness.lifecycle.dispose();
        }
    });
});
