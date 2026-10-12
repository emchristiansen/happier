import { describe, expect, it, vi } from 'vitest';

import type { TransportHandler } from '@/agent/transport';
import { DefaultTransport } from '@/agent/transport';
import { AuggieTransport } from '@/backends/auggie/acp/transport';
import { CodexAcpTransport } from '@/backends/codex/acp/transport';
import { CopilotTransport } from '@/backends/copilot/acp/transport';
import { CursorTransport } from '@/backends/cursor/acp/transport';
import { GeminiTransport } from '@/backends/gemini/acp/transport';
import { KiloTransport } from '@/backends/kilo/acp/transport';
import { KimiTransport } from '@/backends/kimi/acp/transport';
import { OpenCodeTransport } from '@/backends/opencode/acp/transport';

import { createAcpToolCallLifecycle } from '../createAcpToolCallLifecycle';

describe('ACP provider tool-call deadlines', () => {
  it.each([
    ['generic', new DefaultTransport()],
    ['auggie', new AuggieTransport()],
    ['codex', new CodexAcpTransport(60_000, 1_000)],
    ['copilot', new CopilotTransport()],
    ['cursor', new CursorTransport()],
    ['gemini', new GeminiTransport()],
    ['kilo', new KiloTransport()],
    ['kimi', new KimiTransport()],
    ['opencode', new OpenCodeTransport()],
  ] as const)('%s does not synthesize a timeout for healthy provider-owned tool work', (_name, transport) => {
    expect(transport.getToolCallTimeout?.('ordinary-call', 'read')).toBeNull();
    expect(transport.getToolCallTimeout?.('thinking-call', 'think')).toBeNull();
    expect(transport.getToolCallTimeout?.('investigation-task-call', 'task')).toBeNull();
  });

  it('does not invent a deadline when a custom transport omits the optional timeout hook', () => {
    vi.useFakeTimers();
    try {
      const emitted: unknown[] = [];
      const transport: TransportHandler = {
        agentName: 'custom-acp',
        getInitTimeout: () => 60_000,
        getToolPatterns: () => [],
      };
      const lifecycle = createAcpToolCallLifecycle({
        transport,
        emit: (message) => emitted.push(message),
        getToolNameContext: () => ({
          recentPromptHadChangeTitle: false,
          toolCallCountSincePrompt: 0,
        }),
      });

      lifecycle.observe({
        toolCallId: 'long-running-call',
        kind: 'read',
        status: 'in_progress',
      });
      vi.advanceTimersByTime(10 * 60_000);

      expect(lifecycle.activeSize).toBe(1);
      expect(emitted).not.toContainEqual(expect.objectContaining({
        type: 'tool-result',
        callId: 'long-running-call',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
