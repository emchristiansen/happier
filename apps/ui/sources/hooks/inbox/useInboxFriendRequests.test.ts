import { describe, expect, it } from 'vitest';

import { resolveInboxFriendRequestsVisible } from './useInboxFriendRequests';

describe('resolveInboxFriendRequestsVisible', () => {
    it.each([
        { friendsEnabled: true, identityReady: true, expected: true },
        { friendsEnabled: false, identityReady: true, expected: false },
        { friendsEnabled: true, identityReady: false, expected: false },
    ])('owns Inbox friend admission for feature=$friendsEnabled identity=$identityReady', (input) => {
        expect(resolveInboxFriendRequestsVisible(input)).toBe(input.expected);
    });
});
