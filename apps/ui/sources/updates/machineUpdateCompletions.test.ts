import { expect, it } from 'vitest';

import {
    markUpdateCompletionsSeen,
    readUnseenUpdateCompletions,
    recordUpdateCompleted,
} from './updateCompletions';

it('keeps unseen update completions within the server account that started the update', () => {
    const accountA = { serverId: 'server-a', accountId: 'account-a' } as const;
    const accountB = { serverId: 'server-a', accountId: 'account-b' } as const;
    const itemId = 'studio:happier-cli';

    recordUpdateCompleted(accountA, itemId);
    markUpdateCompletionsSeen(accountB);

    expect(readUnseenUpdateCompletions({ ...accountA }).get(itemId)).toBe('done');
    expect(readUnseenUpdateCompletions(accountB).size).toBe(0);
});
