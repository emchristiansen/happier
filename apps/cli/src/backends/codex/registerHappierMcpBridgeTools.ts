import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import {
  CLAUDE_CODE_TOOL_USE_ID_META_KEY,
  readProviderToolCallIdFromMcpExtra,
} from '@/mcp/server/providerToolCallIdMeta';

type ToolRegistrar = Readonly<{
  registerTool: (name: string, definition: any, handler: (args: any, extra?: unknown) => Promise<any>) => void;
}>;

/**
 * The upstream request metadata the HTTP server needs, and nothing else: the
 * provider tool-call id keys idempotent sends. Other upstream `_meta` (such as
 * the upstream progress token) belongs to the stdio leg only.
 */
function readForwardedRequestMetadata(extra: unknown): Record<string, string> | undefined {
  const providerToolCallId = readProviderToolCallIdFromMcpExtra(extra);
  return providerToolCallId ? { [CLAUDE_CODE_TOOL_USE_ID_META_KEY]: providerToolCallId } : undefined;
}

export function registerHappierMcpBridgeTools(
  server: ToolRegistrar,
  deps: Readonly<{
    callHttpTool: (name: string, args: unknown, requestMetadata?: Record<string, string>) => Promise<any>;
  }>,
): void {
  const forward = (name: string) => async (args: any, extra?: unknown) => {
    try {
      const requestMetadata = readForwardedRequestMetadata(extra);
      return requestMetadata
        ? await deps.callHttpTool(name, args, requestMetadata)
        : await deps.callHttpTool(name, args);
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Failed to call tool ${name}: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };

  for (const tool of listBuiltInHappierTools({ surface: 'session_agent' })) {
    const meta = {
      description: tool.description,
      title: tool.title,
      inputSchema: tool.inputSchema,
    };

    server.registerTool(tool.name, meta, forward(tool.name));
  }
}
