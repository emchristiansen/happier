import React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { StructuredMessageBlock } from './StructuredMessageBlock';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('StructuredMessageBlock', () => {
    it('skips rendering when structured message props are referentially stable', async () => {
        const meta = {
            happier: {
                kind: 'participant_message.v1',
                payload: {
                    recipient: {
                        kind: 'agent_team_member',
                        teamId: 'team_1',
                        memberId: 'agent_1',
                        memberLabel: 'Alice',
                    },
                },
            },
        };
        let metaReadCount = 0;
        const message = {
            kind: 'user-text',
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'hello there',
            get meta() {
                metaReadCount += 1;
                return meta;
            },
        } as any;
        const onJumpToAnchor = vi.fn();
        const renderBlock = () => (
            <StructuredMessageBlock
                message={message}
                sessionId="s1"
                onJumpToAnchor={onJumpToAnchor}
            />
        );
        const screen = await renderScreen(renderBlock());

        metaReadCount = 0;
        await act(async () => {
            screen.tree.update(renderBlock());
        });

        expect(metaReadCount).toBe(0);
    });

    it('returns null for unknown kinds', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{ meta: { happier: { kind: 'unknown.v1', payload: {} } } } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;
        expect(tree!.toJSON()).toBeNull();
    });

    it('renders review comments card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        meta: {
                            happier: {
                                kind: 'review_comments.v1',
                                payload: {
                                    sessionId: 's1',
                                    comments: [
                                        {
                                            id: 'c1',
                                            filePath: 'src/a.ts',
                                            source: 'file',
                                            anchor: { kind: 'fileLine', startLine: 1 },
                                            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                                            body: 'nit',
                                            createdAt: 1,
                                        },
                                    ],
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('Review comments');
        expect(serialized).toContain('src/a.ts');
    });

    it('renders participant message card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm1',
                        localId: null,
                        createdAt: 1,
                        text: 'hello there',
                        meta: {
                            happier: {
                                kind: 'participant_message.v1',
                                payload: {
                                    recipient: {
                                        kind: 'agent_team_member',
                                        teamId: 'team_1',
                                        memberId: 'agent_1',
                                        memberLabel: 'Alice',
                                    },
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('To:');
        expect(serialized).toContain('Alice');
        expect(serialized).toContain('hello there');

        const findTextNode = (text: string) =>
            tree!.findAll((n: any) => n.type === 'Text' && n.props?.children === text)[0]!;
        expect(findTextNode('hello there').props.selectable).toBe(true);
    });

    it('renders subagent launch card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm_launch',
                        localId: null,
                        createdAt: 1,
                        text: 'Launch the alpha teammate',
                        meta: {
                            happier: {
                                kind: 'subagent_launch.v1',
                                payload: {
                                    kind: 'agent_team_member_create',
                                    teamId: 'team_1',
                                    memberLabel: 'alpha',
                                    instructions: 'Handle the linting lane',
                                    runInBackground: true,
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('alpha');
        expect(serialized).toContain('Launch the alpha teammate');
    });

    it('renders subagent command card for valid payload', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<StructuredMessageBlock
                    message={{
                        kind: 'user-text',
                        id: 'm_command',
                        localId: null,
                        createdAt: 1,
                        text: 'Shut alpha down',
                        meta: {
                            happier: {
                                kind: 'subagent_command.v1',
                                payload: {
                                    kind: 'agent_team_member_delete',
                                    teamId: 'team_1',
                                    memberId: 'alpha@team_1',
                                    memberLabel: 'alpha',
                                },
                            },
                        },
                    } as any}
                    sessionId="s1"
                    onJumpToAnchor={() => {}}
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('alpha');
        expect(serialized).toContain('Shut alpha down');
    });

    it('renders execution-run completion input as a structured card instead of raw fallback text', async () => {
        const screen = await renderScreen(<StructuredMessageBlock
            message={{
                kind: 'user-text',
                id: 'm_completion',
                localId: null,
                createdAt: 42,
                text: [
                    '<happier_execution_run_notification>',
                    'This is an automated background-run notification from Happier, not a user message.',
                    'Run ID: run_1',
                    'Status: succeeded',
                    '',
                    'Final result:',
                    'Done',
                    '</happier_execution_run_notification>',
                ].join('\n'),
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        executionRunCompletion: {
                            v: 1,
                            runId: 'run_1',
                            status: 'succeeded',
                            finishedAtMs: 42,
                            canInspect: true,
                            summary: 'Done',
                        },
                    },
                },
            } as any}
            sessionId="s1"
        />);

        expect(screen.findByTestId('execution-run-completion:run_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('run_1');
        expect(screen.getTextContent()).toContain('Done');
        expect(screen.getTextContent()).not.toContain('<happier_execution_run_notification>');
    });
});
