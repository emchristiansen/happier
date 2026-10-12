import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createApprovalArtifact(): DecryptedArtifact {
    return {
        id: 'artifact-1',
        title: 'Approval',
        headerVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
        header: {
            title: 'Approve answering the user',
            actionId: 'session.user_action.answer',
            sessionId: 'session-1',
        },
    };
}

installApprovalCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
                React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    status: { error: '#f00' },
                    text: '#fff',
                    textSecondary: '#999',
                    divider: '#333',
                    surfaceHighest: '#222',
                    surfacePressedOverlay: '#333',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle, ...props }: { title: React.ReactNode; subtitle?: React.ReactNode }) => React.createElement(
        'Item',
        props,
        React.createElement('Text', null, title),
        subtitle ? React.createElement('Text', null, subtitle) : null,
    ),
}));

describe('ApprovalInboxCard', () => {
    it('renders canonical parent-projected workspace context without a raw path', async () => {
        const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
        const screen = await renderScreen(
            <ApprovalInboxCard
                artifact={createApprovalArtifact()}
                sessionContext={{
                    sessionTitle: 'Repo session',
                    machineLabel: 'Rebound workstation',
                    workspaceName: 'Happier Core',
                }}
                onPress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Rebound workstation');
        expect(screen.getTextContent()).toContain('Happier Core');
        expect(screen.getTextContent()).not.toContain('/Volumes/target/repo');
        expect(screen.findByType('Item' as never).props.density).toBe('compact');
    });
});
