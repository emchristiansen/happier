import { describe, expect, it, vi } from 'vitest';

import { ClaudeConnectedServiceAuthGroupRequestFence } from './claudeConnectedServiceAuthGroupRequestFence';

describe('ClaudeConnectedServiceAuthGroupRequestFence', () => {
  it('blocks provider message production until current group truth becomes available again', async () => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth({
      kind: 'current_auth_group_unavailable',
      groupId: 'group-1',
      unavailableReason: 'group_missing',
    });

    const released = vi.fn();
    const controller = new AbortController();
    const waiting = fence.waitUntilAvailable(controller.signal).then(released, () => undefined);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();

    fence.applyCurrentTruth({
      kind: 'current_auth_group_available',
      groupId: 'group-2',
      generation: 2,
      credentialRevision: 'revision-2',
    });
    await waiting;
    expect(released).toHaveBeenCalledOnce();
  });

  it('retains the latest available group truth for runtime failure attribution', () => {
    const fence = new ClaudeConnectedServiceAuthGroupRequestFence();
    fence.applyCurrentTruth({
      kind: 'current_auth_group_available',
      groupId: 'group-1',
      generation: 7,
      credentialRevision: 'revision-7',
    });

    expect(fence.readCurrentTruth()).toEqual({
      kind: 'current_auth_group_available',
      groupId: 'group-1',
      generation: 7,
      credentialRevision: 'revision-7',
    });
  });
});
