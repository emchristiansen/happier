import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { createHelpFormatter } from './help.js';

describe('cli-common/output help formatter', () => {
  it('avoids ANSI escapes when color is disabled', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const help = createHelpFormatter(noColorChalk);
    const out = help.renderRows([
      { label: 'happier auth', description: 'Authenticate' },
      { label: 'happier relay', description: 'Relay management' },
    ]);
    expect(out).not.toMatch(/\u001b\[/u);
  });

  it('keeps column alignment stable even when ANSI is enabled', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 1;
    const help = createHelpFormatter(colorChalk);
    const out = help.renderRows([
      { label: 'short', description: 'One' },
      { label: 'a-bit-longer', description: 'Two' },
    ]);
    const stripped = out.replace(/\u001b\[[0-9;]*m/gu, '');
    const lines = stripped.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const secondColumnOffsets = lines.map((line: string) =>
      line.includes('One') ? line.indexOf('  One') : line.indexOf('  Two')
    );
    expect(secondColumnOffsets[0]).toBeGreaterThanOrEqual(2);
    expect(secondColumnOffsets[0]).toBe(secondColumnOffsets[1]);
  });

  it('colours command labels with the brand accent, not cyan', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const out = createHelpFormatter(colorChalk).renderRows([{ label: 'happier auth', description: 'Authenticate' }]);
    expect(out).toContain(colorChalk.hex('#d6a24a')('happier auth'));
    expect(out).not.toContain('\u001b[36m');
  });

  it('keeps every row inside the terminal: long labels get their own line, long descriptions wrap under their column', () => {
    const plain = Object.create(chalk) as typeof chalk;
    plain.level = 0;
    const out = createHelpFormatter(plain).renderRows([
      { label: 'status', description: 'Show whether this computer is connected' },
      { label: 'relay host install --channel <stable|preview> --port <n>', description: 'Install a relay on this computer' },
      { label: 'logs', description: 'Print the most recent daemon log lines so you can see what the background service did last' },
    ], { columns: 60 });
    const lines = out.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // Short labels still share one aligned description column.
    const column = lines.find((line) => line.includes('status'))!.indexOf('Show');
    expect(lines.find((line) => line.trimStart().startsWith('logs'))!.indexOf('Print')).toBe(column);
    // The long label stands alone; its description follows on the next line, in the same column.
    const long = lines.findIndex((line) => line.includes('relay host install'));
    expect(lines[long]!.trim()).toBe('relay host install --channel <stable|preview> --port <n>');
    expect(lines[long + 1]!.indexOf('Install a relay')).toBe(column);
    // Wrapped description lines hang under the description column.
    const logs = lines.findIndex((line) => line.includes('Print the most'));
    expect(lines[logs + 1]!.slice(0, column).trim()).toBe('');
    expect(out).toContain('background service did last');
  });

  it('stacks descriptions under their labels when the description column has no room', () => {
    const plain = Object.create(chalk) as typeof chalk;
    plain.level = 0;
    const out = createHelpFormatter(plain).renderRows([
      { label: 'status', description: 'Show whether this computer is connected to its relay' },
    ], { columns: 40, labelWidth: 31 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
    expect(out).toContain('connected to its relay');
  });

  it('does not wrap when the width is unknown (piped output)', () => {
    const plain = Object.create(chalk) as typeof chalk;
    plain.level = 0;
    const description = 'Print the most recent daemon log lines so you can see what the background service did last';
    const out = createHelpFormatter(plain).renderRows([{ label: 'logs', description }], { columns: undefined });
    expect(out).toBe(`  logs  ${description}`);
  });
});
