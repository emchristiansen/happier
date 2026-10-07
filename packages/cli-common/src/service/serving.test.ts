import { describe, expect, it } from 'vitest';
import { resolveServingThisComputerService } from './serving.js';

describe('this computer serving service', () => {
  it('selects an eligible pin before the default, preserving unreadable pin values', () => {
    expect(resolveServingThisComputerService({
      defaultFollowing: { eligible: true, value: 'default' },
      pinned: [{ eligible: false, value: 'other-relay' }, { eligible: true, value: null }],
    })).toEqual({ serving: 'pinned', value: null });
  });

  it('falls back to the eligible default and reports no target when neither can serve', () => {
    const pinned = [{ eligible: false, value: 'uninstalled-pin' }];
    expect(resolveServingThisComputerService({
      defaultFollowing: { eligible: true, value: 'default' }, pinned,
    })).toEqual({ serving: 'default-following', value: 'default' });
    expect(resolveServingThisComputerService({
      defaultFollowing: { eligible: false, value: 'default' }, pinned,
    })).toBeNull();
  });
});
