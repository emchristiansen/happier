import { realpathSync } from 'node:fs';
import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers';
import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';

let cachedResolvedClaudeCliPath: string | null = null;

export function resolveClaudeCliPath(): string {
  if (cachedResolvedClaudeCliPath) {
    return cachedResolvedClaudeCliPath;
  }

  const resolved = resolveProviderCliCommand('claude', {
    processEnv: process.env,
    currentExecPath: process.execPath,
  });
  if (!resolved) {
    throw new ProviderCliNotFoundError('claude');
  }

  cachedResolvedClaudeCliPath = resolved.command;
  return cachedResolvedClaudeCliPath;
}

export function isClaudeCliJavaScriptFile(cliPath: string): boolean {
  const normalized = typeof cliPath === 'string' ? cliPath.trim() : '';
  // Match the launcher's import path, including extensionless links and links retargeted by updates.
  let launchPath: string;
  try {
    launchPath = realpathSync(normalized);
  } catch {
    // Classification cannot establish a JavaScript target; launching still reports the filesystem failure.
    return false;
  }
  return launchPath.endsWith('.js') || launchPath.endsWith('.cjs') || launchPath.endsWith('.mjs');
}
