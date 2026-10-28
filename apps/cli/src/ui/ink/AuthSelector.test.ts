import { describe, expect, it } from 'vitest';

import { resolveAuthSelectorInput } from './authSelectorInput';

describe('resolveAuthSelectorInput', () => {
  it('navigates within the available methods and confirms the highlighted method', () => {
    expect(resolveAuthSelectorInput('', { downArrow: true }, 0)).toEqual({ selectedIndex: 1 });
    expect(resolveAuthSelectorInput('', { downArrow: true }, 1)).toEqual({ selectedIndex: 1 });
    expect(resolveAuthSelectorInput('', { upArrow: true }, 0)).toEqual({ selectedIndex: 0 });
    expect(resolveAuthSelectorInput('', { return: true }, 1)).toEqual({ selectedIndex: 1, selectedMethod: 'web' });
  });

  it('supports direct numeric choices and both cancellation keys', () => {
    expect(resolveAuthSelectorInput('1', {}, 1)).toEqual({ selectedIndex: 0, selectedMethod: 'mobile' });
    expect(resolveAuthSelectorInput('2', {}, 0)).toEqual({ selectedIndex: 1, selectedMethod: 'web' });
    expect(resolveAuthSelectorInput('', { escape: true }, 0)).toEqual({ selectedIndex: 0, cancelled: true });
    expect(resolveAuthSelectorInput('c', { ctrl: true }, 0)).toEqual({ selectedIndex: 0, cancelled: true });
  });
});
