/**
 * Prompts for a secret value without echoing input (TTY-only).
 */

import { isInteractiveTerminal, promptSecretInput } from './promptInput';

export async function promptSecret(promptLabel: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('promptSecret requires an interactive terminal.');
  }
  try {
    return await promptSecretInput(promptLabel);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Cancelled.');
    throw error;
  }
}
