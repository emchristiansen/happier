import * as React from 'react';

import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useFriendRequests } from '@/sync/domains/state/storage';

type InboxFriendRequests = Readonly<{
    /** Whether the Inbox screen renders the friends section at all. */
    visible: boolean;
    requests: ReturnType<typeof useFriendRequests>;
}>;

const NO_FRIEND_REQUESTS: ReturnType<typeof useFriendRequests> = [];

export function resolveInboxFriendRequestsVisible(input: Readonly<{
    friendsEnabled: boolean;
    identityReady: boolean;
}>): boolean {
    return input.friendsEnabled && input.identityReady;
}

/** Canonical admission decision shared by detailed Inbox and summary chrome. */
export function useInboxFriendRequestsVisible(): boolean {
    const friendsEnabled = useFriendsEnabled();
    const identityReadiness = useFriendsIdentityReadiness();
    return resolveInboxFriendRequestsVisible({
        friendsEnabled,
        identityReady: identityReadiness.isReady,
    });
}

/** One admission decision shared by the Inbox screen and navigation badge. */
export function useInboxFriendRequests(): InboxFriendRequests {
    const visible = useInboxFriendRequestsVisible();
    const requests = useFriendRequests();

    return React.useMemo(
        () => ({ visible, requests: visible ? requests : NO_FRIEND_REQUESTS }),
        [requests, visible],
    );
}
