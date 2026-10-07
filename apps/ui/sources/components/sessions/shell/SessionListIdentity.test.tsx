import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    getAgentPickerIconScale: () => 1,
    resolveAgentIdFromFlavor: (flavor: string | null | undefined) => flavor === 'codex' ? 'codex' : null,
}));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ getSessionAvatarId: () => 'avatar-1' }));

describe('SessionListIdentity', () => {
    it('uses the session provider logo selected for session lists', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo',
                flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                avatarSize={28}
                agentLogoSize={22}
                testID="identity"
            />,
        );

        expect(screen.tree.root.findByType('AgentIcon').props).toMatchObject({
            agentId: 'codex',
            size: 22,
            testID: 'identity',
        });
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });

    it('uses the canonical default agent when list-only metadata has no resolvable provider', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo',
                flavor: 'unknown-provider',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                avatarSize={28}
                agentLogoSize={22}
            />,
        );

        expect(screen.tree.root.findByType('AgentIcon').props.agentId).toBe('claude');
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });
});
