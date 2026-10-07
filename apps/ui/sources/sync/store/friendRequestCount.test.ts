import { describe, expect, it } from 'vitest';

import type { StorageState } from './types';
import { createFriendRequestCountSelector } from './friendRequestCount';

function stateWithFriends(friends: StorageState['friends']): StorageState {
    return { friends } as StorageState;
}

describe('createFriendRequestCountSelector', () => {
    it('skips the friends collection on unrelated store waves and follows status transitions', () => {
        let collectionReads = 0;
        const pending = { id: 'pending', status: 'pending' } as StorageState['friends'][string];
        const accepted = { id: 'accepted', status: 'friend' } as StorageState['friends'][string];
        const friends = new Proxy(
            { pending, accepted },
            {
                ownKeys(target) {
                    collectionReads += 1;
                    return Reflect.ownKeys(target);
                },
            },
        );
        const selector = createFriendRequestCountSelector();
        const initialState = stateWithFriends(friends);

        expect(selector(initialState)).toBe(1);
        expect(collectionReads).toBe(1);

        expect(selector({ ...initialState } as StorageState)).toBe(1);
        expect(collectionReads).toBe(1);

        expect(selector(stateWithFriends({
            pending: { ...pending, status: 'friend' },
            accepted: { ...accepted, status: 'pending' },
            requested: { id: 'requested', status: 'requested' } as StorageState['friends'][string],
        }))).toBe(1);
    });
});
