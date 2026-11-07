import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { createSetupChoicePrompt, renderPlanet, renderSetupChoice, renderSetupWelcome, resolveTerminalTheme, supportsBrailleArt } from './planet';

const PLANET_DOT = /[\u2801-\u28ff]/u;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('setup welcome handoff', () => {
  it('keeps setup context without repeating installer artwork or the brand heading', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    expect(renderSetupWelcome({ machineName: 'preview-machine', subtitle: 'Choose your connection' }).split('\n')).toContain('Happier');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '1');
    const output = renderSetupWelcome({ machineName: 'preview-machine', subtitle: 'Choose your connection', columns: 80 });
    expect(output).toContain('preview-machine');
    expect(output).toContain('Choose your connection');
    expect(output.split('\n')).not.toContain('Happier');
    expect(output).not.toMatch(PLANET_DOT);
  });

  it('places the static planet beside the complete first setup choice on a wide terminal', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const output = renderSetupChoice({
      machineName: 'preview-machine',
      subtitle: 'Connect your devices. Your coding agents run here.',
      question: 'How would you like to connect your devices?',
      choices: [
        { key: 'c', label: 'Happier Cloud (recommended)', description: 'No server maintenance', isDefault: true },
        { key: 'r', label: 'Existing server', description: 'Address from the Happier app or your administrator' },
        { key: 't', label: 'Host on this computer', description: 'Installs an additional server; needs a reachable network route' },
      ],
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    const lines = output.split('\n');
    expect(lines.some((line) => /^[ \u2800-\u28ff]{24} {3}Happier$/u.test(line))).toBe(true);
    expect(lines.some((line) => /^[ \u2800-\u28ff]{24} {3}How would you like to connect your devices\?$/u.test(line))).toBe(true);
    expect(output).toContain('Existing server');
    expect(output).toContain('Happier app or your administrator');
    expect(output.trimEnd().endsWith('Use ↑/↓ to move, Enter to select, or type a letter')).toBe(true);
  });

  it('breaks a word too long for the column beside the planet instead of letting the terminal wrap it', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const machineName = `build-agent-${'x'.repeat(70)}-end`;
    const output = renderSetupChoice({
      machineName,
      subtitle: 'Connect your devices.',
      question: 'Where does your relay live?',
      choices: [{ key: 'c', label: 'Happier Cloud', isDefault: true }],
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    // Redraws count rows; a row the terminal wraps on its own would break them.
    for (const line of output.split('\n')) expect([...line].length).toBeLessThanOrEqual(92);
    expect(output).toMatch(/[⠀-⣿ ]{24} {3}Computer: build-agent-x+$/mu);
    expect(output).toMatch(/x+-end$/mu);
  });

  it('uses compact complete text without the planet on narrow terminals', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const options = {
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [{ key: 'a', label: 'A deliberately long option whose meaning must wrap instead of being cropped', isDefault: true }],
      columns: 44,
      rows: 24,
      isTTY: true,
    } as const;
    const narrow = renderSetupChoice(options);
    expect(narrow).toContain('Happier\nChoose your connection\nComputer: preview-machine');
    expect(narrow.replace(/\n\s*/gu, ' ')).toContain('A deliberately long option whose meaning must wrap instead of being cropped');
    expect(narrow).not.toMatch(PLANET_DOT);

    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '1');
    const handedOff = renderSetupChoice({ ...options, columns: 100 });
    expect(handedOff).not.toContain('Happier');
    expect(handedOff).toMatch(PLANET_DOT);
    expect(handedOff).toContain('Question');
    expect(handedOff).toContain('Computer: preview-machine');
  });

  it('offers idle frames only for a wide capable terminal', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    const base = {
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [{ key: 'a', label: 'Answer', isDefault: true }],
      columns: 92,
      rows: 24,
      isTTY: true,
    } as const;
    const animated = createSetupChoicePrompt(base);
    expect(animated.renderMessage?.(1)).not.toBe(animated.message);
    vi.stubEnv('HAPPIER_NO_ANIMATION', ' TRUE ');
    expect(createSetupChoicePrompt(base)).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    expect(createSetupChoicePrompt({ ...base, columns: 44 })).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
    expect(createSetupChoicePrompt({ ...base, isTTY: false }).renderMessage).toBeUndefined();
  });

  it('marks and highlights the currently selected choice independently of the recommendation', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    const output = renderSetupChoice({
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [
        { key: 'a', label: 'Recommended answer', isDefault: true },
        { key: 'b', label: 'Current answer' },
      ],
      selectedId: 'b',
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    expect(output).toContain('  a) Recommended answer');
    expect(output).toContain('› b) Current answer');
  });

  it('renders setup submenus without repeating welcome context or the planet', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    const prompt = createSetupChoicePrompt({
      machineName: '',
      subtitle: '',
      showWelcome: false,
      question: 'Try again?',
      choices: [
        { id: 'retry', key: 'r', label: 'Retry', isDefault: true },
        { id: 'exit', key: 'x', label: 'Exit' },
      ],
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    expect(prompt.message).toContain('Try again?\n› r) Retry\n  x) Exit');
    expect(prompt.message).not.toContain('Happier');
    expect(prompt.message).not.toContain('Computer:');
    expect(prompt.message).not.toMatch(PLANET_DOT);
    expect(prompt).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
  });
});

describe('setup planet', () => {
  const choiceOptions = {
    machineName: 'preview-machine',
    subtitle: 'Choose your connection',
    question: 'Question',
    choices: [
      { id: 'first', key: 'a', label: 'First answer', isDefault: true },
      { id: 'second', key: 'b', label: 'Second answer' },
    ],
    columns: 92,
    rows: 24,
    isTTY: true,
  } as const;
  const planetDots = (message: string) => message.split('\n').join('').match(/[⠁-⣿]/gu)?.length ?? 0;
  const planetLuminance = (message: string) => {
    const colours = [...message.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m[⠁-⣿]/gu)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    return colours.reduce((sum, [r, g, b]) => sum + 0.2126 * r! + 0.7152 * g! + 0.0722 * b!, 0) / colours.length;
  };

  it('rises out of an eclipse on a fresh welcome, but continues lit after the installer already welcomed', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const fresh = renderSetupChoice({ ...choiceOptions, seconds: 0.25 });
    const settled = renderSetupChoice({ ...choiceOptions, seconds: 8 });
    expect(planetDots(fresh)).toBeLessThan(planetDots(settled) * 0.45);
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '1');
    expect(planetDots(renderSetupChoice({ ...choiceOptions, seconds: 0.25 }))).toBeGreaterThan(planetDots(settled) * 0.8);
  });

  it('keeps breathing but steps back once the user starts choosing', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    const level = chalk.level;
    chalk.level = 3;
    try {
      const prompt = createSetupChoicePrompt(choiceOptions);
      expect(prompt.animate).toBe(true);
      const beforeChoosing = prompt.renderMessage!(8, 'first');
      prompt.renderMessage!(8.05, 'second');
      const whileChoosing = prompt.renderMessage!(9, 'second');
      expect(planetLuminance(whileChoosing)).toBeLessThan(planetLuminance(beforeChoosing) * 0.7);
      // Moving back to the recommendation does not bring the spotlight back.
      expect(planetLuminance(prompt.renderMessage!(10, 'first'))).toBeLessThan(planetLuminance(beforeChoosing) * 0.7);
      // Half a breath later it is still alive, only quieter.
      expect(prompt.renderMessage!(9 + 4.8, 'second')).not.toBe(whileChoosing);
    } finally {
      chalk.level = level;
    }
  });

  it('redraws smoothly while it steps back, then returns to a calm breath', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    const level = chalk.level;
    chalk.level = 3;
    try {
      const prompt = createSetupChoicePrompt(choiceOptions);
      const calm = prompt.intervalMs!(8);
      prompt.renderMessage!(8, 'first');
      prompt.renderMessage!(8.05, 'second');
      // The step back is a short fade: it needs the fast cadence to read as one.
      expect(prompt.intervalMs!(8.2)).toBeLessThan(calm / 2);
      expect(prompt.intervalMs!(9)).toBe(calm);
    } finally {
      chalk.level = level;
    }
  });

  it('leaves the art out where the console has no Braille glyphs', () => {
    expect(supportsBrailleArt({}, 'linux')).toBe(true);
    expect(supportsBrailleArt({}, 'darwin')).toBe(true);
    expect(supportsBrailleArt({}, 'win32')).toBe(false);
    expect(supportsBrailleArt({ WT_SESSION: 'abc' }, 'win32')).toBe(true);
    expect(supportsBrailleArt({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true);

    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('WT_SESSION', '');
    vi.stubEnv('TERM_PROGRAM', '');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const legacyConsole = renderSetupChoice(choiceOptions);
      expect(legacyConsole).not.toMatch(PLANET_DOT);
      expect(legacyConsole).toContain('Second answer');
      expect(createSetupChoicePrompt(choiceOptions)).toMatchObject({ animate: false });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('reads a light terminal from COLORFGBG and defaults to the dark planet', () => {
    expect(resolveTerminalTheme({})).toBe('dark');
    expect(resolveTerminalTheme({ COLORFGBG: '15;0' })).toBe('dark');
    expect(resolveTerminalTheme({ COLORFGBG: '0;15' })).toBe('light');
    expect(resolveTerminalTheme({ COLORFGBG: '0;default;7' })).toBe('light');
  });

  it('renders the settled planet as uncoloured Braille when colour is off', () => {
    const frame = renderPlanet({ columns: 24, color: false });
    expect(frame.join('\n')).toMatch(/^[⠀-⣿ \n]+$/u);
    expect(frame.every((line) => [...line].length <= 24)).toBe(true);
    // Static renderings use the settled, fully lit pose rather than the eclipse's first frame.
    expect(planetDots(frame.join('\n'))).toBeGreaterThan(planetDots(renderPlanet({ columns: 24, seconds: 0.25, color: false }).join('\n')) * 2);
  });
});
