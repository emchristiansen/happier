import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import type { AgentMessage, ToolCallMessage, ToolResultMessage } from '@/agent/core/AgentMessage';
import type { AcpRuntimeBackend } from '../createAcpRuntime';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred } from '@/testkit/async/deferred';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { openCodeTransport } from '@/backends/opencode/acp/transport';

describe('createAcpRuntime (sidechain import)', () => {
  it.each([
    'Task',
    'task',
    'Agent',
    openCodeTransport.determineToolName('change_title', 'task-alias', { _acp: { title: 'task' }, prompt: 'do work' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
  ])('imports %s sub-session replay as sidechain messages when tool-result includes sessionId metadata', async (toolName) => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_123',
      replay: [
        { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        { type: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'echo hi' } },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput: { stdout: 'hi' } },
      ],
    });

    const { session, committed } = createSessionClientWithMetadata();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend: async () => replayBackend,
    });

    await runtime.startOrLoad({ resumeId: null });

    // Simulate Task tool-call and tool-result coming from the main ACP backend.
    const taskCall: ToolCallMessage = { type: 'tool-call', toolName, args: { prompt: 'do work' }, callId: 'tool_task_1' };
    mainBackend.emit(taskCall);
    const taskResult: ToolResultMessage = {
      type: 'tool-result',
      toolName,
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    };
    mainBackend.emit(taskResult);

    await expect.poll(() => committed.some((body) => body.type === 'message' && body.sidechainId === 'tool_task_1')).toBe(true);
  });

  it('falls back to importing Task output as a sidechain message when replay capture is empty', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => ({ sessionId: 'ses_123', replay: [] });

    const importedSidechain = createDeferred<void>();
    const { session, committed } = createSessionClientWithMetadata({
      onSendAgentMessageCommitted: (body) => {
        if (body.sidechainId === 'tool_task_1' && body.type === 'message') importedSidechain.resolve(undefined);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend: async () => replayBackend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const taskCall: ToolCallMessage = { type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' };
    mainBackend.emit(taskCall);
    const taskResult: ToolResultMessage = {
      type: 'tool-result',
      toolName: 'Task',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    };
    mainBackend.emit(taskResult);

    await importedSidechain.promise;
    expect(committed.some((body) => body.sidechainId === 'tool_task_1' && body.type === 'message')).toBe(true);
  });

  it('records replay failure at the default session log level while preserving the fallback', async () => {
    await withTempDir('happier-acp-replay-failure-', async (dir) => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'DEBUG', 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING']);
      env.patch({ HAPPIER_HOME_DIR: dir, HAPPIER_LOG_LEVEL: undefined, DEBUG: undefined, DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: undefined });
      vi.resetModules();
      const { createTestAcpRuntime } = await import('@/testkit/backends/acpRuntime');
      const { logger } = await import('@/ui/logger');
      const { AcpBackend } = await import('@/agent/acp/AcpBackend');
      const mainBackend = createFakeAcpRuntimeBackend();
      const replayBackend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeAcpTestAgentScript({ dir, fileName: 'replay-failure.mjs', source: `
          let buffer = '';
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const request = JSON.parse(line);
              const response = request.method === 'initialize'
                ? { result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } } }
                : request.method === 'session/load'
                  ? { error: { code: -32601, message: 'private-provider-payload' } }
                  : { result: {} };
              if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
            }
          });
        ` })],
        declaredSessionLoadSupport: true,
      });
      const fallbackCommitted = createDeferred<void>();
      const { session, committed } = createSessionClientWithMetadata({
        onSendAgentMessageCommitted(body) {
          if (body.sidechainId === 'tool_task_1' && body.type === 'message') fallbackCommitted.resolve(undefined);
        },
      });
      const runtime = createTestAcpRuntime({
        provider: 'opencode', directory: dir, session, messageBuffer: new MessageBuffer(),
        mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {},
        ensureBackend: async () => mainBackend, createReplayBackend: async () => replayBackend,
      });
      try {
        await runtime.startOrLoad({ resumeId: null });
        mainBackend.emit({ type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' });
        mainBackend.emit({ type: 'tool-result', toolName: 'Task', callId: 'tool_task_1', result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } } });
        await fallbackCommitted.promise;
        expect(committed.some((body) => body.sidechainId === 'tool_task_1' && body.type === 'message')).toBe(true);
        logger.flushSync();
        const log = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
        const diagnostics = log.split('\n').filter((line) => line.includes('"phase":"replay"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
        expect(diagnostics).toContainEqual(expect.objectContaining({ phase: 'replay', errorCode: -32601 }));
        expect(log).not.toContain('private-provider-payload');
      } finally {
        await runtime.reset();
        await replayBackend.dispose({ preserveProviderSession: true });
        logger.flushSync();
        env.restore();
      }
    });
  });

  it('evicts tool-call name cache when maxEntries is exceeded', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();

    let replayLoadCount = 0;
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => {
      replayLoadCount += 1;
      return {
        sessionId: 'ses_123',
        replay: [
          { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        ],
      };
    };

    const { session, committed } = createSessionClientWithMetadata();
    const createReplayBackend = vi.fn(async () => replayBackend);

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend,
      toolCallCache: { maxEntries: 1, ttlMs: 60_000 },
    });

    await runtime.startOrLoad({ resumeId: null });

    // Record a Task tool-call, then push another tool-call to evict it from the bounded cache.
    mainBackend.emit({ type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_old' });
    mainBackend.emit({ type: 'tool-call', toolName: 'OtherTool', args: { foo: 'bar' }, callId: 'tool_other_new' });

    // Now emit a tool-result for the evicted callId, with a non-Task toolName.
    // If eviction happened, origin toolName should *not* resolve to Task and sidechain import should not run.
    mainBackend.emit({
      type: 'tool-result',
      toolName: '???',
      callId: 'tool_task_old',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    });

    expect(createReplayBackend).not.toHaveBeenCalled();
    expect(replayLoadCount).toBe(0);
    expect(committed.some((b) => b.sidechainId === 'tool_task_old')).toBe(false);
  });

  it('clears tool-call name cache on cancel to avoid leaking callIds', async () => {
    const mainBackend = createFakeAcpRuntimeBackend();
    const replayBackend = createFakeAcpRuntimeBackend();

    let replayLoadCount = 0;
    replayBackend.loadSessionWithReplayCapture = async (_id: string) => {
      replayLoadCount += 1;
      return {
        sessionId: 'ses_123',
        replay: [
          { type: 'message', role: 'agent', text: 'SUBTASK says hello' },
        ],
      };
    };

    const { session, committed } = createSessionClientWithMetadata();
    const createReplayBackend = vi.fn(async () => replayBackend);

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => mainBackend,
      createReplayBackend,
      toolCallCache: { maxEntries: 100, ttlMs: 60_000 },
    });

    await runtime.startOrLoad({ resumeId: null });

    mainBackend.emit({ type: 'tool-call', toolName: 'Task', args: { prompt: 'do work' }, callId: 'tool_task_1' });

    await runtime.cancel();

    mainBackend.emit({
      type: 'tool-result',
      toolName: '???',
      callId: 'tool_task_1',
      result: { output: 'SUBTASK_OK', metadata: { sessionId: 'ses_123' } },
    });

    expect(createReplayBackend).not.toHaveBeenCalled();
    expect(replayLoadCount).toBe(0);
    expect(committed.some((b) => b.sidechainId === 'tool_task_1')).toBe(false);
  });
});
