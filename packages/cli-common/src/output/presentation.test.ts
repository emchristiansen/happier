import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { createTerminalPresentation, createTerminalStyles } from './presentation';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('createTerminalPresentation', () => {
  it('formats banners, bullets, section titles, and definition lists', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const presentation = createTerminalPresentation(colorChalk);

    // The brand title: bold gold (the step printer's accent), no decorative sparkles.
    const banner = presentation.banner('setup', { subtitle: 'Guided setup' });
    expect(banner).toContain('\u001B[1m');
    expect(banner).toContain('\u001B[38;2;214;162;74m');
    expect(banner).not.toContain('\u001B[36m');
    expect(stripAnsi(banner)).toBe('setup\nGuided setup');

    expect(stripAnsi(presentation.sectionTitle('Plan'))).toBe('Plan');
    expect(stripAnsi(presentation.cmd('happier auth login'))).toBe('happier auth login');
    expect(stripAnsi(presentation.bullets(['one', null, 'two']))).toBe('- one\n- two');

    const definitionList = presentation.definitionList([
      { label: 'Relay', value: 'https://relay.example.test' },
      { label: 'Machine ID', value: 'machine-123' },
    ]);
    expect(definitionList).toContain('\u001B[');
    expect(stripAnsi(definitionList)).toContain('Relay:');
    expect(stripAnsi(definitionList)).toContain('Machine ID:');
  });

  it('formats status lines and error frames with stable structure', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const presentation = createTerminalPresentation(colorChalk);

    expect(stripAnsi(presentation.ok('Ready'))).toBe('✓ Ready');
    expect(stripAnsi(presentation.warn('Needs attention'))).toBe('! Needs attention');
    expect(stripAnsi(presentation.fail('Failed'))).toBe('x Failed');

    // An error frame is a failed status line: the same red x as fail(), details below in gray.
    const errorFrame = presentation.errorFrame("Couldn't install Codex:", ['First detail', 'Second detail']);
    expect(stripAnsi(errorFrame)).toBe("x Couldn't install Codex\n  First detail\n  Second detail");
    expect(errorFrame.split('\n')[0]).toBe(presentation.fail("Couldn't install Codex"));
    // Informational dots use the brand accent, never cyan.
    expect(presentation.info('Tip')).toContain('\u001B[38;2;214;162;74m');
    expect(presentation.info('Tip')).not.toContain('\u001B[36m');
  });

  it('formats generic frames and checklists with stable structure', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const presentation = createTerminalPresentation(colorChalk);

    const frame = presentation.frame('warning', "Can't reach Relay", ['Retry', 'Use a different URL']);
    expect(frame).toContain('\u001B[');
    expect(stripAnsi(frame)).toBe(["! Can't reach Relay", '  Retry', '  Use a different URL'].join('\n'));

    const checklist = presentation.checklist([
      { state: 'success', label: 'Install CLI' },
      { state: 'pending', label: 'Connect to relay' },
      { state: 'error', label: 'Pair this computer', details: ['Denied by server'] },
    ]);
    expect(checklist).toContain('\u001B[');
    expect(stripAnsi(checklist)).toBe(
      [
        '- [✓] Install CLI',
        '- [..] Connect to relay',
        '- [x] Pair this computer',
        '  Denied by server',
      ].join('\n'),
    );
    // Same glyphs and colours as the step printer's linear mode: an unstyled `..`, a green ✓, a red x.
    expect(checklist).toContain('- [..] Connect to relay');
    expect(checklist).toContain(`- [${colorChalk.green('✓')}] Install CLI`);
    expect(checklist).toContain(`- [${colorChalk.red('x')}] Pair this computer`);
  });
});

describe('createTerminalStyles', () => {
  it('exposes consistent style helpers that respect ansi availability', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const styles = createTerminalStyles(colorChalk);

    expect(styles.ansiEnabled()).toBe(true);
    expect(styles.bold('hello')).toContain('\u001B[');
    expect(stripAnsi(styles.bold('hello'))).toBe('hello');
    expect(stripAnsi(styles.gray('muted'))).toBe('muted');

    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const noColorStyles = createTerminalStyles(noColorChalk);
    expect(noColorStyles.ansiEnabled()).toBe(false);
    expect(noColorStyles.bold('plain')).toBe('plain');
  });
});
