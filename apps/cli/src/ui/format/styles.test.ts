import { describe, expect, it } from 'vitest';

import { cmd, fail, info, ok, warn } from '@happier-dev/cli-common/output';

import { bold, code, glyph, muted, statusGlyph, subLineArrow, success, warning } from './styles';

describe('styles palette', () => {
  it('muted wraps text', () => {
    expect(muted('abc')).toContain('abc');
  });

  it('bold wraps text', () => {
    expect(bold('abc')).toContain('abc');
  });

  it('warning wraps text', () => {
    expect(warning('heads up')).toContain('heads up');
  });

  it('success wraps text', () => {
    expect(success('done')).toContain('done');
  });

  it('status glyph returns a ● character for every kind', () => {
    for (const kind of ['running', 'drifted', 'stopped'] as const) {
      expect(statusGlyph(kind)).toContain('●');
    }
  });

  it('sub-line arrow contains ↳', () => {
    expect(subLineArrow()).toContain('↳');
  });

  it('uses the same status glyphs and command style as the rest of the CLI', () => {
    expect(glyph.error()).toBe(fail());
    expect(glyph.action()).toBe(warn());
    expect(glyph.success()).toBe(ok());
    expect(glyph.info()).toBe(info());
    expect(code('happier doctor repair')).toBe(cmd('happier doctor repair'));
  });
});
