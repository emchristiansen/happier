import type { StorageState } from './types';

export function createFriendRequestCountSelector(): (state: StorageState) => number {
    let previousFriends: StorageState['friends'] | null = null;
    let previousCount = 0;

    return (state) => {
        if (state.friends === previousFriends) return previousCount;
        previousFriends = state.friends;
        previousCount = 0;
        for (const friend of Object.values(state.friends)) {
            if (friend.status === 'pending') previousCount += 1;
        }
        return previousCount;
    };
}
