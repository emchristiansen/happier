/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { closeSync, createWriteStream, openSync, type WriteStream } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { ReadStream } from 'node:tty';

export type PromptAnimation = Readonly<{
  animate?: boolean;
  /** Milliseconds between redraws, or a function of elapsed seconds for a cadence that changes over time. */
  intervalMs?: number | ((elapsedSeconds: number) => number);
  render: (elapsedSeconds: number) => string;
  onMove?: (delta: -1 | 1) => void;
  onToggle?: () => void;
  answerOnEmpty?: () => string;
}>;

type PromptOptions = Readonly<{
  animation?: PromptAnimation;
}>;

/**
 * Decide whether we can ask the user a question, given what the process can see.
 *
 * Pure so the `curl | bash` case can be tested without a terminal.
 */
export function resolveInteractiveTerminal(params: Readonly<{
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  platform: NodeJS.Platform | string;
  hasControllingTty: () => boolean;
  /**
   * A caller has stated that nobody is watching this run, whatever the terminal
   * looks like. Installers set this for their whole run, and `happier setup
   * --yes` sets it for the commands it spawns — a controlling terminal is still
   * attached in both cases, so nothing below can tell.
   */
  unattended?: boolean;
}>): boolean {
  if (params.unattended) {
    return false;
  }
  if (params.stdinIsTty && params.stdoutIsTty) {
    return true;
  }
  if (params.platform === 'win32') {
    return false;
  }
  return params.hasControllingTty();
}

/**
 * A device node at /dev/tty is not proof of a terminal — in a container it can
 * exist and still fail to open with ENXIO. Opening it is the only real check.
 */
function hasControllingTty(): boolean {
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: we only opened it to find out whether we could.
      }
    }
  }
}

/**
 * Whether the CLI can prompt.
 *
 * `process.stdin` is not the whole story. Under `curl … | bash -s -- --run <cmd>`
 * the installer hands us an exhausted pipe on stdin while the user is still sat
 * at a terminal — and `promptInput` below already prompts through a freshly
 * opened /dev/tty in exactly that case. Gating on stdin alone made every
 * installer-invoked command run blind, which is why those call sites had to pass
 * `--yes`.
 */
export function isInteractiveTerminal(): boolean {
  return resolveInteractiveTerminal({
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    platform: process.platform,
    hasControllingTty,
    unattended: String(process.env.HAPPIER_NONINTERACTIVE ?? '') === '1',
  });
}

type TerminalOutput = NodeJS.WritableStream & { columns?: number; rows?: number };
type ReadlineWithOutputInterceptor = Interface & {
  _writeToOutput?: (value: string) => void;
};

function askQuestion(
  rl: Interface,
  input: NodeJS.ReadableStream,
  output: TerminalOutput,
  prompt: string,
  animation?: PromptAnimation,
  secret = false,
): Promise<string> {
  const intercepted = rl as ReadlineWithOutputInterceptor;
  const originalWriteToOutput = intercepted._writeToOutput;
  if (secret) {
    animation = undefined;
    output.write(prompt);
    if (originalWriteToOutput) intercepted._writeToOutput = () => undefined;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onKeypress: ((value: string, key: Readonly<{ name?: string }>) => void) | null = null;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const initialColumns = output.columns;
    const initialRows = output.rows;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      rl.removeListener('SIGINT', onAbort);
      rl.removeListener('close', onClose);
      if (onKeypress) input.removeListener('keypress', onKeypress);
      output.removeListener('resize', stopRedraw);
      if (output !== process.stdout) process.stdout.removeListener('resize', stopRedraw);
      if (process.platform !== 'win32') process.removeListener('SIGWINCH', stopRedraw);
      if (secret) {
        if (originalWriteToOutput) intercepted._writeToOutput = originalWriteToOutput;
        output.write('\n');
      }
      settle();
    };
    const onAbort = (): void => {
      const error = new Error('Terminal prompt aborted');
      error.name = 'AbortError';
      finish(() => reject(error));
    };
    const onClose = (): void => {
      const error = new Error('Terminal prompt closed');
      error.name = 'AbortError';
      finish(() => reject(error));
    };
    rl.once('SIGINT', onAbort);
    rl.once('close', onClose);
    let redrawEnabled = true;
    const canRedraw = (): boolean => {
      const cursor = rl.getCursorPos();
      return (output === process.stdout || (typeof initialColumns === 'number' && typeof initialRows === 'number'))
        && output.columns === initialColumns
        && output.rows === initialRows
        && !(typeof initialRows === 'number' && cursor.rows >= initialRows - 1);
    };
    const stopRedraw = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      redrawEnabled = false;
    };
    output.on('resize', stopRedraw);
    if (output !== process.stdout) process.stdout.on('resize', stopRedraw);
    if (process.platform !== 'win32') process.on('SIGWINCH', stopRedraw);
    const redraw = (): void => {
      if (!canRedraw()) {
        stopRedraw();
        return;
      }
      const elapsedSeconds = animation!.animate === false ? 0 : (Date.now() - startedAt) / 1000;
      rl.setPrompt(animation!.render(elapsedSeconds));
      rl.prompt(true);
    };
    if (animation) {
      onKeypress = (_value, key) => {
        if (key.name === 'escape') {
          onAbort();
          return;
        }
        const isToggle = key.name === 'space' || _value === ' ';
        if (!redrawEnabled || (key.name !== 'up' && key.name !== 'down' && !isToggle)) return;
        if (!canRedraw()) {
          stopRedraw();
          return;
        }
        if (isToggle) {
          animation!.onToggle?.();
          rl.write(null, { ctrl: true, name: 'u' });
        } else {
          animation!.onMove?.(key.name === 'up' ? -1 : 1);
        }
        redraw();
      };
      input.on('keypress', onKeypress);
      if (animation!.animate !== false) {
        const nextDelay = (): number => {
          const interval = animation!.intervalMs;
          const value = typeof interval === 'function' ? interval((Date.now() - startedAt) / 1000) : interval;
          return Math.max(40, value ?? 120);
        };
        const tick = (): void => {
          redraw();
          if (timer === null) return;
          timer = setTimeout(tick, nextDelay());
          timer.unref?.();
        };
        timer = setTimeout(tick, nextDelay());
        timer.unref?.();
      }
    }
    try {
      rl.question(secret ? '' : prompt, (value) => {
        const answer = value === '' ? animation?.answerOnEmpty?.() ?? value : value;
        finish(() => resolve(answer));
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/**
 * Open terminal input independently of inherited stdin. Installer redirects can
 * leave Bun's inherited stdin unable to receive keys even when it reports TTY.
 * Borrow an existing terminal stdout; creating another tty output is unnecessary
 * and fails with EINVAL in Bun on macOS. Owned file output flushes before closing.
 */
async function promptTerminalInput(prompt: string, options: PromptOptions, secret = false): Promise<string> {
  let input: ReadStream | null = null;
  let output: WriteStream | null = null;
  let inputFd: number | null = null;
  let outputFd: number | null = null;
  if (process.platform !== 'win32') {
    try {
      inputFd = openSync('/dev/tty', 'r+');
      input = new ReadStream(inputFd);
      inputFd = null;
      if (!process.stdout.isTTY) {
        // File output avoids Bun's TTY constructor; terminal stderr supplies live geometry when available.
        outputFd = openSync('/dev/tty', 'r+');
        output = Object.defineProperties(createWriteStream('/dev/tty', { fd: outputFd, autoClose: true }), {
          columns: { get: () => process.stderr.isTTY ? process.stderr.columns : undefined },
          rows: { get: () => process.stderr.isTTY ? process.stderr.rows : undefined },
        });
        outputFd = null;
      }
    } catch {
      input?.destroy();
      output?.destroy();
      input = null;
      output = null;
      if (inputFd !== null) closeSync(inputFd);
      if (outputFd !== null) closeSync(outputFd);
    }
  }
  const promptInputStream = input ?? process.stdin;
  const promptOutputStream = output ?? process.stdout;
  let rl: Interface | null = null;
  try {
    rl = createInterface({
      input: promptInputStream,
      output: promptOutputStream,
      ...(input || (secret && process.stdin.isTTY) ? { terminal: true } : {}),
    });
    return await askQuestion(rl, promptInputStream, promptOutputStream, prompt, options.animation, secret);
  } finally {
    rl?.close();
    input?.destroy();
    if (output && !output.destroyed && !output.writableEnded) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          output!.off('finish', finish);
          output!.off('error', finish);
          resolve();
        };
        output.once('finish', finish);
        output.once('error', finish);
        output.end();
      });
    }
    output?.destroy();
  }
}

export async function promptInput(prompt: string, options: PromptOptions = {}): Promise<string> {
  return promptTerminalInput(prompt, options);
}

export async function promptSecretInput(prompt: string): Promise<string> {
  return promptTerminalInput(prompt, {}, true);
}
