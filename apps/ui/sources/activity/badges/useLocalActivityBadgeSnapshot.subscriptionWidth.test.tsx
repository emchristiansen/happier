import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage, storage } from '@/sync/domains/state/storageStore';

import { useLocalActivityBadgeSnapshot } from './useLocalActivityBadgeSnapshot';

const SESSION_OPTIONS = {
    showUnread: true,
    showPendingPermissionRequests: true,
    showPendingUserActionRequests: true,
    showQueuedUserInput: true,
} as const;

const SESSION_ID = 'badge-session';

function renderable(hasUnreadMessages: boolean): SessionListRenderableSession {
    return {
        id: SESSION_ID,
        seq: 3,
        lastViewedSessionSeq: 1,
        hasUnreadMessages,
        metadata: { path: '', host: '' },
    } as unknown as SessionListRenderableSession;
}

function useBadgeSnapshot() {
    return useLocalActivityBadgeSnapshot({
        badgesEnabled: true,
        friendRequestCount: 0,
        hasNonNumericInboxAttention: false,
        sessionOptions: SESSION_OPTIONS,
    });
}

function seedRenderables(hasUnreadMessages: boolean, deltaRevision: number): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {},
        sessionListRenderables: { [SESSION_ID]: renderable(hasUnreadMessages) },
        sessionListRenderableDelta: {
            revision: deltaRevision,
            changedSessionIds: [SESSION_ID],
            removedSessionIds: [],
            rebuiltSessionListViewData: false,
        },
    }));
}

describe('useLocalActivityBadgeSnapshot subscription width', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('does not re-render when only the session-list change envelope ticks', async () => {
        seedRenderables(false, 2_000);

        let renders = 0;
        let controlRenders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useBadgeSnapshot();
        });
        // Control: proves the harness can observe a re-render at all, so a flat
        // `renders` count above is evidence and not an inert test.
        await renderHook(() => {
            controlRenders += 1;
            return getStorage()((state) => state.sessionListRenderableDelta);
        });

        const rendersBefore = renders;
        const controlBefore = controlRenders;
        const snapshotBefore = hook.getCurrent();

        await act(async () => {
            seedRenderables(false, 2_001);
        });
        await act(async () => {
            seedRenderables(false, 2_002);
        });

        expect(controlRenders).toBe(controlBefore + 2);
        expect(renders).toBe(rendersBefore);
        expect(hook.getCurrent()).toBe(snapshotBefore);
    });

    it('re-renders when the badge count actually changes', async () => {
        seedRenderables(false, 3_000);

        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useBadgeSnapshot();
        });
        expect(hook.getCurrent().count).toBe(0);
        const rendersBefore = renders;

        await act(async () => {
            seedRenderables(true, 3_001);
        });

        expect(hook.getCurrent().count).toBe(1);
        expect(renders).toBe(rendersBefore + 1);
    });
});
