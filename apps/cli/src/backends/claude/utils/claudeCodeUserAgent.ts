import { execFileSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { resolveProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export const DEFAULT_CLAUDE_CODE_USER_AGENT = 'claude-cli/0.0.0 (external, cli)';

let cachedClaudeCodeUserAgent: string | null = null;

export function parseClaudeCodeVersionForUserAgent(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const match = text.match(/\b(\d+(?:\.\d+){1,3}(?:[-+._a-zA-Z0-9]*)?)\b/u);
  return match?.[1] ?? null;
}

export function resetClaudeCodeUserAgentCacheForTests(): void {
  cachedClaudeCodeUserAgent = null;
}

export function resolveClaudeCodeUserAgent(value?: unknown): string {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  if (cachedClaudeCodeUserAgent) return cachedClaudeCodeUserAgent;

  try {
    const launch = resolveProviderCliLaunchSpec('claude');
    if (!launch) {
      cachedClaudeCodeUserAgent = DEFAULT_CLAUDE_CODE_USER_AGENT;
      return cachedClaudeCodeUserAgent;
    }

    const rawVersion = execFileSync(
      launch.command,
      [...launch.args, '--version'],
      {
        encoding: 'utf8',
        windowsHide: true,
        ...(configuration.vendorCliHelpTimeoutMs > 0 ? { timeout: configuration.vendorCliHelpTimeoutMs } : {}),
      },
    );
    const version = parseClaudeCodeVersionForUserAgent(rawVersion);
    cachedClaudeCodeUserAgent = version ? `claude-cli/${version} (external, cli)` : DEFAULT_CLAUDE_CODE_USER_AGENT;
    return cachedClaudeCodeUserAgent;
  } catch {
    cachedClaudeCodeUserAgent = DEFAULT_CLAUDE_CODE_USER_AGENT;
    return cachedClaudeCodeUserAgent;
  }
}
