import type { Metadata } from '@/api/types';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readClaudeActiveTerminalMode(input: Readonly<{
  terminalRuntime?: TerminalRuntimeFlags | null;
  metadata?: Metadata | Record<string, unknown> | null;
}>): string | null {
  if (input.terminalRuntime?.mode) return input.terminalRuntime.mode;
  if (readNonEmptyString(input.terminalRuntime?.tmuxTarget)) return 'tmux';

  const metadata = readRecord(input.metadata);
  const terminal = readRecord(metadata?.terminal);
  const mode = readNonEmptyString(terminal?.mode);
  if (mode) return mode;

  const tmux = readRecord(terminal?.tmux);
  if (readNonEmptyString(tmux?.target)) return 'tmux';

  return null;
}

export function readClaudeActiveUnifiedTerminalHost(input: Readonly<{
  terminalRuntime?: TerminalRuntimeFlags | null;
  metadata?: Metadata | Record<string, unknown> | null;
}>): 'tmux' | 'zellij' | 'herdr' | null {
  const mode = readClaudeActiveTerminalMode(input);
  return mode === 'tmux' || mode === 'zellij' || mode === 'herdr' ? mode : null;
}
