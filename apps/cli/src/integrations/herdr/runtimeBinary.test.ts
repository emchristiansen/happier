import { describe, expect, it } from 'vitest';

import { isSupportedHerdrVersion } from './runtimeBinary';

describe('Herdr minimum version', () => {
  it('requires stable releases at or after 0.9.2', () => {
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-28-80c0c07250d2')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-29-abcdef123456')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-27-abcdef123456')).toBe(false);
    expect(isSupportedHerdrVersion('herdr 0.9.1')).toBe(false);
    expect(isSupportedHerdrVersion('0.8.9')).toBe(false);
    expect(isSupportedHerdrVersion('1.0.0')).toBe(true);
    expect(isSupportedHerdrVersion('1.0.0-preview.1')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.2')).toBe(true);
    expect(isSupportedHerdrVersion('0.10.0')).toBe(true);
  });
});
