import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { getFriendsList } from '@/sync/api/social/apiFriends';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveRuntimeFeatureDecisionOrThrow } from '@/sync/domains/features/featureDecisionInputs';

export async function fetchAndApplyFriends(params: {
    credentials: AuthCredentials | null | undefined;
    applyFriends: (friends: UserProfile[]) => void;
    shouldContinue?: () => boolean;
}): Promise<void> {
    if (!params.credentials) {
        return;
    }
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    const activeServer = getActiveServerSnapshot();
    const decision = await resolveRuntimeFeatureDecisionOrThrow({
        featureId: 'social.friends',
        serverId: activeServer.serverId,
    });
    if (!shouldContinue()) return;

    if (decision.state !== 'enabled') {
        return;
    }

    const friendsList = await getFriendsList(params.credentials);
    if (!shouldContinue()) return;
    params.applyFriends(friendsList);
}
