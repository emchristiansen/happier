import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';
import { PLANET_FRAME_INTERVAL_MS, createPlanetFrame, planetFrameIntervalMs, planetRowsForColumns, type PlanetTheme } from '../../planetFrame.mjs';
import { ACCENT_HEX } from './presentation.js';

export function isTerminalAnimationDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.HAPPIER_NO_ANIMATION ?? '').trim().toLowerCase());
}

/**
 * Braille art needs a font with the Braille block. macOS and Linux terminals fall back
 * to one; the legacy Windows console host does not, so there only Windows Terminal
 * (WT_SESSION) and hosts that identify themselves (TERM_PROGRAM, e.g. VS Code) get it.
 */
export function supportsBrailleArt(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true;
  return Boolean(String(env.WT_SESSION ?? '').trim() || String(env.TERM_PROGRAM ?? '').trim());
}

/**
 * COLORFGBG ("fg;bg" or "fg;default;bg") is the background hint terminals publish
 * without being queried; white backgrounds (7, 15) get the light planet.
 */
export function resolveTerminalTheme(env: NodeJS.ProcessEnv = process.env): PlanetTheme {
  const background = String(env.COLORFGBG ?? '').split(';').at(-1)?.trim();
  return background === '7' || background === '15' ? 'light' : 'dark';
}

const easeInOut = (value: number): number => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

/**
 * A gold highlight band sweeping across text (phase 0 → 1). It only adds colour to
 * the terminal's own foreground, so it reads on light and dark backgrounds alike.
 */
export function shimmerText(text: string, phase: number, colors: typeof chalk = chalk): string {
  if (colors.level === 0 || phase < 0 || phase > 1) return text;
  const chars = [...text];
  const position = -4 + phase * (chars.length + 8);
  return chars.map((ch, index) => {
    const distance = Math.abs(index - position);
    if (distance <= 1.5) return colors.hex('#ffd98a')(ch);
    if (distance <= 3.5) return colors.hex(ACCENT_HEX)(ch);
    return ch;
  }).join('');
}

/** Brand texture only; no identifiers, credentials or progress data. */
export function renderPlanet(options: Readonly<{
  columns?: number;
  /** Seconds since the planet appeared; omit for the settled, fully lit pose. */
  seconds?: number;
  intro?: boolean;
  dim?: number;
  chalkLike?: typeof chalk;
  color?: boolean;
}> = {}): string[] {
  const colors = options.chalkLike ?? chalk;
  return createPlanetFrame({
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    ...(options.intro === undefined ? {} : { intro: options.intro }),
    ...(options.dim === undefined ? {} : { dim: options.dim }),
    theme: resolveTerminalTheme(),
  }).map((row) => {
    const line = row.map((cell) => {
      if (!cell) return ' ';
      return options.color === false || colors.level === 0
        ? cell.ch
        : colors.rgb(...cell.rgb)(cell.ch);
    }).join('');
    return line.trimEnd();
  });
}

export function renderSetupWelcome(options: Readonly<{
  machineName: string;
  subtitle: string;
  columns?: number;
}>): string {
  // The bootstrapper already introduced Happier. Keep this operation's context,
  // but do not restart the visual welcome when it hands over to guided setup.
  if (process.env.HAPPIER_INSTALLER_WELCOME_SHOWN === '1') {
    return ['', options.subtitle, `Computer: ${options.machineName}`, ''].join('\n');
  }
  const rich = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
  const width = options.columns ?? process.stdout.columns ?? 80;
  const lines = rich && width >= 40 && (process.stdout.rows ?? 24) >= 18 && supportsBrailleArt()
    ? renderPlanet({ color: !process.env.NO_COLOR })
    : [];
  return [...lines, '', 'Happier', options.subtitle, `Computer: ${options.machineName}`, ''].join('\n');
}

export type SetupChoice = Readonly<{
  id?: string;
  key: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}>;

export type SetupChoiceRenderOptions = Readonly<{
  machineName: string;
  subtitle: string;
  question: string;
  description?: string;
  choices: readonly SetupChoice[];
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  /** Seconds since the prompt appeared; omit for the settled, static pose. */
  seconds?: number;
  selectedId?: string;
  /** When the user first moved the selection; the planet steps back from then on. */
  interactedAtSeconds?: number;
  showWelcome?: boolean;
}>;

export type SetupChoicePrompt = Readonly<{
  message: string;
  animate?: boolean;
  renderMessage?: (elapsedSeconds: number, selectedId?: string) => string;
  /** Redraw cadence at a given moment: smooth while the planet turns, calm once it only breathes. */
  intervalMs?: (elapsedSeconds: number) => number;
}>;

const SETUP_PLANET_WIDTH = 24;
/** How long the planet takes to step back once the user starts choosing. */
const STEP_BACK_SECONDS = 0.4;
const SETUP_PLANET_GAP = 3;
const SETUP_MIN_RIGHT_WIDTH = 42;

function wrapSetupText(value: string, width: number, indent = ''): string[] {
  const available = Math.max(12, width - indent.length);
  const words = value.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [indent];
  const lines: string[] = [];
  let line = '';
  for (let word of words) {
    // A word wider than the column (a long computer name) is broken here: left to the terminal,
    // it would wrap onto a row the redraw does not count.
    while (word.length > available) {
      const room = line ? available - line.length - 1 : available;
      if (room <= 0) {
        lines.push(`${indent}${line}`);
        line = '';
        continue;
      }
      lines.push(`${indent}${line ? `${line} ` : ''}${word.slice(0, room)}`);
      line = '';
      word = word.slice(room);
    }
    if (line && line.length + 1 + word.length > available) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(`${indent}${line}`);
  return lines;
}

function renderSetupChoiceText(options: SetupChoiceRenderOptions, width: number, showBrand: boolean, color: boolean): string[] {
  const gold = (value: string): string => color ? chalk.hex(ACCENT_HEX)(value) : value;
  const title = (value: string): string => color ? chalk.bold(value) : value;
  const lines: string[] = [];
  if (options.showWelcome !== false) {
    // One slow highlight across the name while the planet rises; then it stays still.
    const brandPhase = options.seconds === undefined ? -1 : (options.seconds - 0.5) / 1.6;
    if (showBrand) lines.push(title(color ? shimmerText('Happier', brandPhase) : 'Happier'));
    lines.push(...wrapSetupText(options.subtitle, width));
    lines.push(...wrapSetupText(`Computer: ${options.machineName}`, width), '');
  }
  lines.push(...wrapSetupText(options.question, width).map((line) => gold(title(line))));
  if (options.description) lines.push(...wrapSetupText(options.description, width));
  const selectedId = options.selectedId ?? options.choices.find((choice) => choice.isDefault)?.id ?? options.choices.find((choice) => choice.isDefault)?.key;
  for (const choice of options.choices) {
    const selected = (choice.id ?? choice.key) === selectedId;
    const prefix = `${selected ? '›' : ' '} ${choice.key}) `;
    const labelLines = wrapSetupText(choice.label, width, ' '.repeat(prefix.length));
    const firstLabel = labelLines[0]!.slice(prefix.length);
    lines.push(selected
      ? gold(title(`${prefix}${firstLabel}`))
      : `${gold(`  ${choice.key})`)} ${firstLabel}`);
    for (const continuation of labelLines.slice(1)) {
      lines.push(selected ? gold(title(continuation)) : continuation);
    }
    if (choice.description) {
      lines.push(...wrapSetupText(choice.description, width, ' '.repeat(prefix.length)));
    }
  }
  return lines;
}

function canRenderSetupChoiceRich(options: SetupChoiceRenderOptions, width: number, rows: number, isTTY: boolean, showBrand: boolean): boolean {
  if (!isTTY || process.env.TERM === 'dumb' || width < SETUP_PLANET_WIDTH + SETUP_PLANET_GAP + SETUP_MIN_RIGHT_WIDTH || !supportsBrailleArt()) {
    return false;
  }
  const rightWidth = width - SETUP_PLANET_WIDTH - SETUP_PLANET_GAP;
  const rightLineCount = renderSetupChoiceText(options, rightWidth, showBrand, false).length;
  const planetLineCount = planetRowsForColumns(SETUP_PLANET_WIDTH);
  return Math.max(rightLineCount, planetLineCount) + 2 < rows;
}

/**
 * Render the welcome and setup's actual first choice as one bounded block.
 * The answer remains a normal line prompt below it; this function owns no input
 * or cursor state and is safe to use as a stable animation frame.
 */
export function renderSetupChoice(options: SetupChoiceRenderOptions): string {
  const width = Math.max(20, Math.floor(options.columns ?? process.stdout.columns ?? 80));
  const rows = options.rows ?? process.stdout.rows ?? 24;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const showBrand = process.env.HAPPIER_INSTALLER_WELCOME_SHOWN !== '1';
  const color = isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR && chalk.level > 0;
  const rich = options.showWelcome !== false && canRenderSetupChoiceRich(options, width, rows, isTTY, showBrand);
  if (!rich) {
    const prompt = isTTY && process.env.TERM !== 'dumb'
      ? 'Use ↑/↓ to move, Enter to select, or type a letter'
      : 'Choose';
    return [...renderSetupChoiceText(options, width, showBrand, color), '', prompt].join('\n');
  }

  const rightWidth = width - SETUP_PLANET_WIDTH - SETUP_PLANET_GAP;
  const right = renderSetupChoiceText(options, rightWidth, showBrand, color);
  const planet = renderPlanet({
    columns: SETUP_PLANET_WIDTH,
    ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    // After the installer's welcome the planet is already up; setup continues it.
    intro: showBrand,
    dim: options.interactedAtSeconds === undefined || options.seconds === undefined
      ? 0
      : easeInOut((options.seconds - options.interactedAtSeconds) / STEP_BACK_SECONDS),
    color: !process.env.NO_COLOR,
  });
  const lines: string[] = [];
  for (let index = 0; index < Math.max(planet.length, right.length); index += 1) {
    const left = planet[index] ?? '';
    const content = right[index] ?? '';
    const paddedLeft = `${left}${' '.repeat(Math.max(0, SETUP_PLANET_WIDTH - stripVTControlCharacters(left).length))}`;
    lines.push(content ? `${paddedLeft}${' '.repeat(SETUP_PLANET_GAP)}${content}` : left);
  }
  return [...lines, '', 'Use ↑/↓ to move, Enter to select, or type a letter'].join('\n');
}

export function createSetupChoicePrompt(options: SetupChoiceRenderOptions): SetupChoicePrompt {
  const message = renderSetupChoice(options);
  const width = Math.max(20, Math.floor(options.columns ?? process.stdout.columns ?? 80));
  const rows = options.rows ?? process.stdout.rows ?? 24;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const showBrand = process.env.HAPPIER_INSTALLER_WELCOME_SHOWN !== '1';
  const rich = options.showWelcome !== false && canRenderSetupChoiceRich(options, width, rows, isTTY, showBrand);
  const canNavigate = isTTY && process.env.TERM !== 'dumb';
  const canAnimate = !isTerminalAnimationDisabled() && rich;
  if (!canNavigate) return { message };
  const initialId = options.selectedId
    ?? options.choices.find((choice) => choice.isDefault)?.id
    ?? options.choices.find((choice) => choice.isDefault)?.key;
  let interactedAtSeconds: number | undefined;
  return {
    // A static prompt shows the settled planet; an animated one starts at its first frame.
    message: canAnimate ? renderSetupChoice({ ...options, seconds: 0 }) : message,
    animate: canAnimate,
    // The step back is a short fade and needs smooth frames; otherwise follow the planet's own cadence.
    intervalMs: (elapsedSeconds) => interactedAtSeconds !== undefined && elapsedSeconds - interactedAtSeconds < STEP_BACK_SECONDS
      ? PLANET_FRAME_INTERVAL_MS
      : planetFrameIntervalMs(elapsedSeconds),
    renderMessage: (elapsedSeconds, selectedId) => {
      if (interactedAtSeconds === undefined && selectedId !== undefined && selectedId !== initialId) {
        interactedAtSeconds = elapsedSeconds;
      }
      return renderSetupChoice({
        ...options,
        ...(canAnimate ? { seconds: elapsedSeconds } : {}),
        ...(selectedId === undefined ? {} : { selectedId }),
        ...(interactedAtSeconds === undefined ? {} : { interactedAtSeconds }),
      });
    },
  };
}
