import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';

import { useSessionRowActionMenu } from './useSessionRowActionMenu';

describe('useSessionRowActionMenu', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('dispatches contextual menu item selections through their owning handler', async () => {
        const session: SessionListRenderableSession = {
            id: 'session_1',
            active: false,
            archivedAt: null,
            owner: 'user_1',
            accessLevel: undefined,
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const target = createSessionActionTarget({
            session,
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });
        const onSelectLeadingMenuItem = vi.fn(async () => undefined);

        const hook = await renderHook(() => useSessionRowActionMenu({
            target,
            sessionName: 'Session 1',
            hideInactiveSessions: false,
            iconColor: '#999',
            activeTags: [],
            knownTags: [],
            tagsEnabled: false,
            leadingMenuItems: [
                { id: 'session.copyDebugInformation', title: 'Copy information' },
            ],
            onSelectLeadingMenuItem,
            selectionModeAvailable: false,
            selectionModeActive: false,
            isNativeMobile: false,
            setContextMenuOpen: vi.fn(),
            openTagsMenuFromContext: vi.fn(),
        }));

        expect(hook.getCurrent().moreMenuItems.some((item) => item.id === 'session.copyDebugInformation')).toBe(true);

        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect('session.copyDebugInformation');
        });

        expect(onSelectLeadingMenuItem).toHaveBeenCalledWith('session.copyDebugInformation');
    });
});
