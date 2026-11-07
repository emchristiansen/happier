import { promptInput } from './promptInput';

/**
 * Multi-choice prompt that supports arrow navigation on a capable terminal and
 * keeps single-letter/full-word aliases everywhere. Empty line input picks the
 * default; Enter after arrow navigation picks the highlighted option.
 *
 * Letter aliases remain case-insensitive and are the static/non-TTY fallback.
 */
export type MultipleChoiceOption<TId extends string> = Readonly<{
  /** The id returned when this option is chosen. */
  id: TId;
  /**
   * The single-letter key (or multi-char word) the user types. Multiple
   * accepted aliases allowed — e.g. `['y', 'yes']`. Case-insensitive.
   */
  keys: readonly string[];
  /** Short label used in the `[Y/n/r/p]` suffix. Usually a single uppercase letter when default, lowercase otherwise. */
  short: string;
}>;

export async function promptMultipleChoice<TId extends string>(
  message: string,
  options: readonly MultipleChoiceOption<TId>[],
  config: Readonly<{
    defaultId: TId;
    maxAttempts?: number;
    promptInputFn?: typeof promptInput;
    animate?: boolean;
    renderMessage?: (elapsedSeconds: number, selectedId?: TId) => string;
    intervalMs?: number | ((elapsedSeconds: number) => number);
  }>,
): Promise<TId> {
  const readAnswer = config.promptInputFn ?? promptInput;
  if (options.length === 0) {
    throw new Error('promptMultipleChoice requires at least one option');
  }
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const suffix = `[${options.map((o) => (o.id === config.defaultId ? o.short.toUpperCase() : o.short.toLowerCase())).join('/')}] `;
  const fullPrompt = `${message.trimEnd()} ${suffix}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let selectedIndex = Math.max(0, options.findIndex((option) => option.id === config.defaultId));
    const answer = config.renderMessage
      ? await readAnswer(fullPrompt, {
          animation: {
            animate: config.animate,
            ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
            render: (seconds) => `${config.renderMessage!(seconds, options[selectedIndex]!.id).trimEnd()} ${suffix}`,
            onMove: (delta) => { selectedIndex = (selectedIndex + delta + options.length) % options.length; },
            answerOnEmpty: () => options[selectedIndex]!.keys.find((key) => key.length > 0) ?? options[selectedIndex]!.short,
          },
        })
      : await readAnswer(fullPrompt);
    const raw = answer.trim().toLowerCase();
    if (raw === '') return config.defaultId;
    const match = options.find((o) => o.keys.some((k) => k.toLowerCase() === raw));
    if (match) return match.id;
    // unrecognised — re-prompt
  }
  return config.defaultId;
}

type MultipleSelectionChoice<TId extends string> = Readonly<{
  id: TId;
  label: string;
  description?: string;
  selected?: boolean;
  kind?: 'choice';
}>;

type MultipleSelectionSkip = Readonly<{
  id: string;
  label: string;
  description?: string;
  kind: 'skip';
}>;

export type MultipleSelectionOption<TId extends string> = MultipleSelectionChoice<TId> | MultipleSelectionSkip;

export async function promptMultipleSelection<TId extends string>(
  message: string,
  options: readonly MultipleSelectionOption<TId>[],
  config: Readonly<{ promptInputFn?: typeof promptInput }> = {},
): Promise<TId[]> {
  if (options.length === 0) return [];
  const readAnswer = config.promptInputFn ?? promptInput;
  let selectedIndex = 0;
  const selectableOptions = options.filter(
    (option): option is MultipleSelectionChoice<TId> => option.kind !== 'skip',
  );
  const selected = new Set<TId>(selectableOptions.filter((option) => option.selected).map((option) => option.id));
  const render = (): string => {
    const rows = options.map((option, index) => {
      const cursor = index === selectedIndex ? '›' : ' ';
      const marker = option.kind === 'skip' ? '   ' : selected.has(option.id) ? '[x]' : '[ ]';
      const description = option.description ? ` — ${option.description}` : '';
      const fallbackKey = option.kind === 'skip'
        ? 'skip'
        : String(selectableOptions.findIndex((candidate) => candidate.id === option.id) + 1);
      return `  ${cursor} ${marker} ${fallbackKey}. ${option.label}${description}`;
    });
    return [
      message.trimEnd(), '', ...rows, '',
      'Use ↑/↓ to move, Space to toggle, Enter to continue.',
      'Plain terminal: type comma-separated numbers or ids; type skip to skip.',
    ].join('\n');
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await readAnswer(`${render()} `, {
      animation: {
        animate: false,
        render: () => `${render()} `,
        onMove: (delta) => { selectedIndex = (selectedIndex + delta + options.length) % options.length; },
        onToggle: () => {
          const option = options[selectedIndex]!;
          if (option.kind === 'skip') selected.clear();
          else if (selected.has(option.id)) selected.delete(option.id);
          else selected.add(option.id);
        },
        answerOnEmpty: () => '__submit__',
      },
    });
    const raw = answer.trim();
    if (raw === '__submit__' || raw === '') {
      if (options[selectedIndex]?.kind === 'skip') return [];
      return selectableOptions.filter((option) => selected.has(option.id)).map((option) => option.id);
    }
    if (raw.toLowerCase() === 'skip' || options.some((option) => option.kind === 'skip' && option.id.toLowerCase() === raw.toLowerCase())) return [];
    const ids = raw.split(',').map((token) => token.trim()).filter(Boolean).map((token) => {
      const index = Number.parseInt(token, 10);
      if (String(index) === token && index >= 1 && index <= selectableOptions.length) return selectableOptions[index - 1]!.id;
      return selectableOptions.find((option) => option.id.toLowerCase() === token.toLowerCase())?.id ?? null;
    });
    if (ids.length > 0 && ids.every((id): id is TId => id !== null)) return Array.from(new Set(ids));
  }
  throw new Error('Invalid selection after 3 attempts.');
}
