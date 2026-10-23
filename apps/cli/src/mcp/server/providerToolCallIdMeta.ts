/**
 * MCP request `_meta` key under which Claude Code sends the id of the tool_use
 * block it is executing. Claude Code repeats it when it retries that same call
 * (after MCP session recovery), so it identifies one tool call across retries.
 */
export const CLAUDE_CODE_TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';

/**
 * The provider tool-call id an MCP request carries, if its client exposes one.
 *
 * `extra.requestId` is deliberately not a fallback: a JSON-RPC request id
 * restarts with every connection and changes on every retry.
 */
export function readProviderToolCallIdFromMcpExtra(extra: unknown): string | null {
  const extraRecord = extra && typeof extra === 'object' ? extra as Record<string, unknown> : {};
  const meta = extraRecord._meta && typeof extraRecord._meta === 'object' && !Array.isArray(extraRecord._meta)
    ? extraRecord._meta as Record<string, unknown>
    : {};
  const value = meta[CLAUDE_CODE_TOOL_USE_ID_META_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
