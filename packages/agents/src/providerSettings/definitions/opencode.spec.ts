import { describe, expect, it } from 'vitest';

import {
  normalizeOpenCodeCliGeneration,
  normalizeOpenCodeServerBaseUrl,
  readOpenCodeExplicitServerBaseUrl,
} from './opencode.js';

describe('OpenCode provider settings normalization', () => {
  it('normalizes the requested CLI generation without inventing aliases', () => {
    expect(normalizeOpenCodeCliGeneration(' v2 ')).toBe('v2');
    expect(normalizeOpenCodeCliGeneration('STABLE')).toBe('stable');
    expect(normalizeOpenCodeCliGeneration('beta')).toBe('auto');
    expect(normalizeOpenCodeCliGeneration(null)).toBe('auto');
  });

  it('accepts localhost http urls', () => {
    expect(normalizeOpenCodeServerBaseUrl(' http://127.0.0.1:4096/ ')).toBe('http://127.0.0.1:4096/');
    expect(normalizeOpenCodeServerBaseUrl('http://localhost:4096')).toBe('http://localhost:4096/');
  });

  it('normalizes accepted urls to their origin only', () => {
    expect(normalizeOpenCodeServerBaseUrl('http://127.0.0.1:4096/api?x=1#hash')).toBe('http://127.0.0.1:4096/');
    expect(normalizeOpenCodeServerBaseUrl('https://example.com:4096/nested/path?x=1')).toBe('https://example.com:4096/');
  });

  it('rejects remote plaintext http urls', () => {
    expect(normalizeOpenCodeServerBaseUrl('http://example.com:4096')).toBeNull();
  });

  it('rejects urls that embed credentials', () => {
    expect(normalizeOpenCodeServerBaseUrl('https://user:pass@example.com:4096')).toBeNull();
    expect(readOpenCodeExplicitServerBaseUrl('https://user:pass@example.com:4096', true)).toBeNull();
  });
});
