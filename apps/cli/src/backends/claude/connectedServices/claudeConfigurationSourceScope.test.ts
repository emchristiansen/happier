import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPathWithinDirectory } from './claudeConfigurationSourceScope';

describe('isPathWithinDirectory', () => {
  const root = join(sep, 'home', 'user', '.claude');

  it.each([
    ['the root itself', root],
    ['an ordinary descendant', join(root, 'nested', 'settings.json')],
    ['a descendant named with leading dots', join(root, '..nested', 'settings.json')],
    ['a descendant named exactly with three dots', join(root, '...', 'settings.json')],
  ])('keeps %s inside the root', (_name, path) => {
    expect(isPathWithinDirectory(path, root)).toBe(true);
  });

  it.each([
    ['the parent directory', join(sep, 'home', 'user')],
    ['a sibling', join(sep, 'home', 'user', '.claude.json')],
    ['a sibling sharing a dotted prefix', join(sep, 'home', 'user', '.claude-other', 'settings.json')],
    ['an unrelated tree', join(sep, 'etc', 'passwd')],
  ])('places %s outside the root', (_name, path) => {
    expect(isPathWithinDirectory(path, root)).toBe(false);
  });
});
