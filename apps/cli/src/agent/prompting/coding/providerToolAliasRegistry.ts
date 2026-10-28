import { resolveOpenCodeChangeTitleToolNameForMcpClient } from '@/backends/opencode/server/openCodeMcpToolNames';

export function resolvePreferredChangeTitleToolNameForProvider(
  providerId: string | null | undefined,
  options?: Readonly<{ openCodeMcpClientName?: string | null }>,
): string {
  const normalized = typeof providerId === 'string' ? providerId.trim() : '';
  if (normalized === 'opencode') {
    return resolveOpenCodeChangeTitleToolNameForMcpClient(options?.openCodeMcpClientName ?? 'happier');
  }
  return 'mcp__happier__change_title';
}
