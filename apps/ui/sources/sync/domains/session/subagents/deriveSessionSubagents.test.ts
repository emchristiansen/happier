import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { deriveSessionSubagents } from './deriveSessionSubagents';
import { deriveSessionSubagentActivityPreview } from './deriveSessionSubagentActivityPreview';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    seq?: number;
    input?: any;
    result?: any;
    toolExtras?: Record<string, unknown>;
    messageExtras?: Record<string, unknown>;
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        ...(params.messageExtras ?? {}),
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: now,
        tool: {
            name: params.name,
            state: params.state,
            input: params.input ?? {},
            createdAt: now,
            startedAt: now,
            completedAt: params.state === 'running' ? null : now + 1,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
            ...(params.toolExtras ?? {}),
        },
        children: [],
    };
}

function createUserTextMessage(params: { id: string; text: string; seq?: number; meta?: MessageMeta }): Message {
    return {
        kind: 'user-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: Date.now(),
        text: params.text,
        ...(params.meta ? { meta: params.meta } : {}),
    } as Message;
}

function deriveSubagents(params: {
    session: any;
    messages: readonly Message[];
    activeExecutionRuns?: readonly { runId: string; status?: string | null }[];
}) {
    return deriveSessionSubagents(params);
}

describe('deriveSessionSubagents', () => {
    it('binds a proven native child turn to its transcript and preserves explicit interruption', () => {
        const message = createToolMessage({ id: 'native', name: 'SubAgent', state: 'completed', toolExtras: { id: JSON.stringify(['child', 'turn-1']) }, input: { sidechainId: 'child', threadId: 'child', providerTurnId: 'turn-1' }, result: { sidechainId: 'child', status: 'interrupted' } });
        expect(deriveSessionSubagents({ session: { metadata: { flavor: 'codex' } }, messages: [message] })[0]).toMatchObject({ status: 'cancelled', transcript: { sidechainId: 'child' } });
    });

    it('preserves interruption from an error-shaped native occurrence result', () => {
        const sidechainId = JSON.stringify(['thread-resumed-child', 'child-first']);
        const message = createToolMessage({ id: 'native-error', name: 'SubAgent', state: 'error',
            toolExtras: { id: sidechainId },
            input: { threadId: 'thread-resumed-child', providerTurnId: 'child-first', sidechainId },
            result: { threadId: 'thread-resumed-child', providerTurnId: 'child-first', sidechainId, status: 'interrupted' },
        });
        expect(deriveSessionSubagents({ session: { metadata: { flavor: 'codex' } }, messages: [message] })[0])
            .toMatchObject({ status: 'cancelled', transcript: { sidechainId, toolId: sidechainId } });
    });

    it('opens the exact resumed native occurrence while retaining its completed history', () => {
        const firstSidechainId = JSON.stringify(['thread-resumed-child', 'child-first']);
        const resumedSidechainId = JSON.stringify(['thread-resumed-child', 'child-resumed']);
        const first = createToolMessage({ id: 'native-first', name: 'SubAgent', state: 'completed', seq: 1,
            toolExtras: { id: firstSidechainId },
            input: { threadId: 'thread-resumed-child', providerTurnId: 'child-first', sidechainId: firstSidechainId },
            result: { threadId: 'thread-resumed-child', providerTurnId: 'child-first', sidechainId: firstSidechainId, status: 'completed' },
        });
        const resumed = createToolMessage({ id: 'native-resumed', name: 'SubAgent', state: 'running', seq: 2,
            toolExtras: { id: resumedSidechainId },
            input: { threadId: 'thread-resumed-child', providerTurnId: 'child-resumed', sidechainId: resumedSidechainId },
        });
        const reducerState = { sidechains: new Map([
            [firstSidechainId, [{ text: 'First turn output' }]],
            [resumedSidechainId, [{ text: 'Resumed turn output' }]],
        ]) };
        for (const messages of [[first, resumed], [resumed, first]]) {
            const rows = deriveSessionSubagents({ session: { metadata: { flavor: 'codex' } }, messages });
            expect(rows).toHaveLength(2);
            const current = rows.filter((row) => row.status === 'running');
            expect(current).toHaveLength(1);
            expect(current[0]?.transcript).toMatchObject({ sidechainId: resumedSidechainId, toolId: resumedSidechainId });
            expect(resolveToolTranscriptSidechainId({ tool: resumed.tool, normalizedToolName: 'SubAgent' })).toBe(resumedSidechainId);
            expect(deriveSessionSubagentActivityPreview({ subagent: current[0]!, reducerState })).toBe('Resumed turn output');
            const history = rows.find((row) => row.status === 'succeeded');
            expect(history?.transcript.sidechainId).toBe(firstSidechainId);
            expect(deriveSessionSubagentActivityPreview({ subagent: history!, reducerState })).toBe('First turn output');
        }
    });

    it('projects the newest native turn of a retained child independently of transcript input order', () => {
        const oldTurn = createToolMessage({ id: 'old', name: 'SubAgent', state: 'completed', toolExtras: { id: JSON.stringify(['child', 'turn-1']) }, input: { sidechainId: 'child' }, result: { sidechainId: 'child', status: 'completed' } });
        oldTurn.createdAt = 1_000;
        const newTurn = createToolMessage({ id: 'new', name: 'SubAgent', state: 'running', toolExtras: { id: JSON.stringify(['child', 'turn-2']) }, input: { sidechainId: 'child' } });
        newTurn.createdAt = 5_000;
        for (const messages of [[oldTurn, newTurn], [newTurn, oldTurn]]) {
            const rows = deriveSessionSubagents({ session: { metadata: { flavor: 'codex' } }, messages });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'running', transcript: { sidechainId: 'child', toolId: JSON.stringify(['child', 'turn-2']) } });
        }
    });

    it('keeps newer sidechain evidence live after an older runtime loss', () => {
        const message = createToolMessage({ id: 'launch', name: 'Task', state: 'running', toolExtras: { id: 'child' } });
        message.createdAt = 1_000;
        message.tool.createdAt = 1_000;
        message.tool.startedAt = 1_000;
        message.children = [{ kind: 'agent-text', id: 'recent-child', localId: null, createdAt: 5_000, text: 'Still working' }];
        expect(deriveSessionSubagents({ session: { metadata: { flavor: 'claude' } }, messages: [message], runtimeLostSinceMs: 4_000 })[0]?.status).toBe('running');
    });

    it('derives running execution run subagents with control capabilities', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_run_1',
                    name: 'SubAgentRun',
                    state: 'running',
                    input: { runId: 'run_1', label: 'Reviewer A' },
                    result: { sidechainId: 'subagent_run_1' },
                    toolExtras: { id: 'tool_subagent_run_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'execution_run:run_1',
                    kind: 'execution_run',
                    status: 'running',
                    display: expect.objectContaining({ title: 'Reviewer A' }),
                    transcript: expect.objectContaining({
                        sidechainId: 'subagent_run_1',
                        toolMessageRouteId: 'message_run_1',
                        toolId: 'tool_subagent_run_1',
                    }),
                    recipient: expect.objectContaining({ kind: 'execution_run', runId: 'run_1' }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canStop: true,
                        canOpenAdvancedRun: true,
                    }),
                }),
            ]),
        );
    });

    it('derives claude teammate subagents with sidechain routing and send capability', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'alpha',
                        groupKey: 'probe',
                        groupLabel: 'probe',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_alpha',
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'alpha@probe',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps a newly launched Claude teammate visible from subagent_launch.v1 meta even after the session already has team tool history', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                    result: { ok: true },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'completed',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createUserTextMessage({
                    id: 'message_member_launch',
                    text: 'Launch teammate gamma',
                    meta: {
                        happier: {
                            kind: 'subagent_launch.v1',
                            payload: {
                                kind: 'agent_team_member_create',
                                teamId: 'probe',
                                memberLabel: 'gamma',
                                instructions: 'Investigate gamma and reply.',
                                runInBackground: true,
                            },
                        },
                    },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:gamma@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'gamma',
                        groupKey: 'probe',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'gamma@probe',
                        memberLabel: 'gamma',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: false,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps the spawn tool route as the canonical full-open target for claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('upgrades a claude teammate route from a descendant agent tool to the later spawn task route', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('keeps the explicit spawn task route when later teammate task activity appears', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_spawn' },
                }),
                createToolMessage({
                    id: 'message_task_descendant',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha', prompt: 'follow-up work' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_spawn',
                        sidechainId: 'tool_task_spawn',
                    }),
                }),
            ]),
        );
    });

    it('derives generic SubAgent sidechains as monitor-only subagents when they are not execution runs or claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'codex' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                    status: 'running',
                    display: expect.objectContaining({
                        providerLabel: 'Codex',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_generic',
                        toolMessageRouteId: 'tool:tool_task_generic',
                        toolId: 'tool_task_generic',
                    }),
                    recipient: null,
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: false,
                        canStop: false,
                        canDelete: false,
                    }),
                }),
            ]),
        );
    });

    it('derives provider-native completion-only SubAgent activity without fabricating a child transcript or controls', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_task',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        operation: 'run',
                        description: 'Inspect the integration',
                        prompt: 'Sanitized private prompt',
                        subagent_type: 'specialist',
                        model: 'cursor-model',
                        agent_id: 'cursor-agent-1',
                        duration_ms: 42,
                        _acp: { snapshotUpdatedAt: 10_000 },
                        _happier: {
                            v: 2,
                            protocol: 'acp',
                            provider: 'cursor',
                            rawToolName: 'Task',
                            canonicalToolName: 'SubAgent',
                            nativeSubagent: {
                                v: 1,
                                lifecycle: 'completion_only',
                                type: 'custom',
                                customType: 'specialist',
                                model: 'cursor-model',
                                agentId: 'cursor-agent-1',
                                durationMs: 42,
                            },
                        },
                    },
                    toolExtras: { id: 'opaque\ncursor-task-id ' },
                    messageExtras: { realID: 'server-cursor-task' },
                }),
            ],
        });

        expect(subagents).toEqual([
            expect.objectContaining({
                id: 'subagent_sidechain:opaque\ncursor-task-id ',
                kind: 'subagent_sidechain',
                status: 'succeeded',
                display: expect.objectContaining({
                    title: 'Inspect the integration',
                    subtitle: 'specialist · cursor-model',
                    providerLabel: 'Cursor',
                }),
                transcript: {
                    toolMessageRouteId: 'server:server-cursor-task',
                    toolId: 'opaque\ncursor-task-id ',
                },
                nativeRef: {
                    lifecycle: 'completion_only',
                    type: 'custom',
                    customType: 'specialist',
                    model: 'cursor-model',
                    agentId: 'cursor-agent-1',
                    durationMs: 42,
                },
                recipient: null,
                capabilities: {
                    canOpen: true,
                    canSend: false,
                    canStop: false,
                    canLaunchChild: false,
                    canDelete: false,
                    canOpenAdvancedRun: false,
                },
                timestamps: {
                    startedAtMs: 9_958,
                    updatedAtMs: 10_000,
                    finishedAtMs: 10_000,
                },
            }),
        ]);
        expect(subagents[0]?.transcript.sidechainId).toBeUndefined();
        expect(subagents[0]?.timestamps.startedAtMs).toBe(9_958);
    });

    it('fails closed on oversized or out-of-contract native task display metadata from durable history', async () => {
        const oversized = 'x'.repeat(513);
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_malformed_native_task',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        description: 'Bounded native task',
                        _happier: {
                            nativeSubagent: {
                                v: 1,
                                lifecycle: 'completion_only',
                                type: oversized,
                                model: oversized,
                                agentId: oversized,
                                durationMs: 2_592_000_001,
                            },
                        },
                    },
                    toolExtras: { id: 'malformed-native-task-id' },
                }),
            ],
        });

        expect(subagents).toEqual([
            expect.objectContaining({
                display: expect.not.objectContaining({ subtitle: expect.anything() }),
                nativeRef: { lifecycle: 'completion_only' },
                timestamps: expect.not.objectContaining({ startedAtMs: expect.anything() }),
            }),
        ]);
    });

    it('bounds completion-only titles and never promotes the private task prompt into the routine subagent list', async () => {
        const longDescription = `Visible description ${'x'.repeat(700)}`;
        const privatePrompt = 'PRIVATE_TASK_PROMPT_MUST_NOT_BECOME_A_LIST_TITLE';
        const nativeMarker = {
            nativeSubagent: {
                v: 1,
                lifecycle: 'completion_only',
                type: 'explore',
            },
        } as const;
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'cursor' } },
            messages: [
                createToolMessage({
                    id: 'message_cursor_long_description',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        description: longDescription,
                        prompt: privatePrompt,
                        _happier: nativeMarker,
                    },
                    toolExtras: { id: 'long-description-task' },
                }),
                createToolMessage({
                    id: 'message_cursor_prompt_only',
                    name: 'SubAgent',
                    state: 'completed',
                    input: {
                        prompt: privatePrompt,
                        _happier: nativeMarker,
                    },
                    toolExtras: { id: 'prompt-only-task' },
                }),
            ],
        });

        const longDescriptionTask = subagents.find((candidate) => candidate.transcript.toolId === 'long-description-task');
        const promptOnlyTask = subagents.find((candidate) => candidate.transcript.toolId === 'prompt-only-task');
        expect(longDescriptionTask?.display.title.startsWith('Visible description')).toBe(true);
        expect(longDescriptionTask?.display.title.length).toBeLessThanOrEqual(512);
        expect(longDescriptionTask?.display.title).not.toContain(privatePrompt);
        expect(promptOnlyTask?.display.title).toBe('SubAgent');
        expect(promptOnlyTask?.display.title).not.toContain(privatePrompt);
    });

    it('prefers a pending permission tool route for generic subagents until the provider sidechain can proceed', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_permission_generic',
                    name: 'task',
                    state: 'running',
                    input: {
                        permission: 'task',
                        patterns: ['general'],
                        always: ['*'],
                        metadata: {
                            description: 'Run pwd',
                            subagent_type: 'general',
                        },
                    },
                    toolExtras: {
                        id: 'per_subagent_1',
                        permission: {
                            id: 'per_subagent_1',
                            status: 'pending',
                            kind: 'permission',
                        },
                    },
                }),
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: {
                        description: 'Run pwd',
                        prompt: 'Use the Bash tool to run `pwd` and return the output.',
                        subagent_type: 'general',
                    },
                    result: { status: 'running' },
                    toolExtras: { id: 'call_subagent_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:call_subagent_1',
                    kind: 'subagent_sidechain',
                    transcript: expect.objectContaining({
                        sidechainId: 'call_subagent_1',
                        toolMessageRouteId: 'tool:per_subagent_1',
                        toolId: 'call_subagent_1',
                    }),
                }),
            ]),
        );
    });

    it('keeps legacy Task and Agent tool names compatible with generic subagent derivation', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'Task',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
                createToolMessage({
                    id: 'message_agent_generic',
                    name: 'Agent',
                    state: 'completed',
                    input: { prompt: 'Summarize the repo' },
                    result: { status: 'completed' },
                    toolExtras: { id: 'tool_agent_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                }),
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_agent_generic',
                    kind: 'subagent_sidechain',
                }),
            ]),
        );
    });

});
