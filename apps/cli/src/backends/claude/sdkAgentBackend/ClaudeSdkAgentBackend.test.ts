import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

function createFakeClaudeEntrypointSource(): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');

const logPath = process.env.FAKE_CLAUDE_LOG_PATH || '';
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2), env: { XDG_STATE_HOME: process.env.XDG_STATE_HOME || null } }) + '\\n', 'utf8');
}

const toolName = process.env.FAKE_CLAUDE_TOOL_NAME || '';
const toolInput = process.env.FAKE_CLAUDE_TOOL_INPUT ? JSON.parse(process.env.FAKE_CLAUDE_TOOL_INPUT) : {};
const hangTurn = process.env.FAKE_CLAUDE_HANG_TURN === '1';
const compactTurn = process.env.FAKE_CLAUDE_COMPACT_TURN === '1';
const multiChunk = process.env.FAKE_CLAUDE_MULTI_CHUNK === '1';
const emitToolFlow = process.env.FAKE_CLAUDE_EMIT_TOOL_FLOW === '1';
const emitWriteFlow = process.env.FAKE_CLAUDE_EMIT_WRITE_FLOW === '1';
const emitDiffFlow = process.env.FAKE_CLAUDE_EMIT_DIFF_FLOW === '1';
const emitUsage = process.env.FAKE_CLAUDE_EMIT_USAGE === '1';

let turn = 0;
let didInit = false;
let didCompact = false;

const args = process.argv.slice(2);
const resumeIdx = args.findIndex((a) => a === '--resume' || a === '-r');
const isResuming = resumeIdx >= 0;
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const nativeSettings = {
  model: argValue('--model') || process.env.FAKE_CLAUDE_DEFAULT_MODEL || 'claude-opus-5-5[1m]',
  effort: argValue('--effort') || process.env.FAKE_CLAUDE_START_EFFORT || 'high',
  ultracode: false,
};
// FAKE_CLAUDE_HOLD_FIRST_GET=1 leaves the first get_settings unanswered until an interrupt arrives.
let heldGetSettings = process.env.FAKE_CLAUDE_HOLD_FIRST_GET === '1' ? 'waiting' : null;
const answerSettingsControl = (msg) => {
  const payload = msg.request.subtype === 'get_settings' ? { response: { applied: { ...nativeSettings, advisor: null }, effective: {}, sources: [] } } : {};
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', ...payload } }) + '\\n');
};
// Use UUID-like values to mirror real Claude Code behavior.
const sessionId = isResuming ? '1433467f-ff14-4292-b5b2-2aac77a808f0' : 'aada10c6-9299-4c45-abc4-91db9c0f935d';

// Claude Code stream-json emits an init message that includes the effective session id.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
didInit = true;

const rl = readline.createInterface({ input: process.stdin });
	rl.on('line', (line) => {
	    const trimmed = String(line || '').trim();
	    if (!trimmed) return;
	    let msg;
	    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg && msg.type === 'control_request' && msg.request
      && (msg.request.subtype === 'get_settings' || msg.request.subtype === 'apply_flag_settings')) {
      // Mirrors native Claude Code 2.1.280: get_settings reports the applied (alias- and
      // default-resolved) model; apply_flag_settings acknowledges even settings it then ignores.
      if (logPath) fs.appendFileSync(logPath, JSON.stringify({ kind: 'control', subtype: msg.request.subtype, settings: msg.request.settings }) + '\\n', 'utf8');
      if (process.env.FAKE_CLAUDE_NO_SETTINGS_CONTROL === '1') {
        process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'error', error: 'Unsupported control request subtype: ' + msg.request.subtype } }) + '\\n');
        return;
      }
      if (msg.request.subtype === 'apply_flag_settings' && process.env.FAKE_CLAUDE_IGNORE_APPLY !== '1') {
        if (typeof msg.request.settings.effortLevel === 'string') nativeSettings.effort = msg.request.settings.effortLevel;
        if (typeof msg.request.settings.ultracode === 'boolean') nativeSettings.ultracode = msg.request.settings.ultracode;
      }
      if (msg.request.subtype === 'get_settings' && heldGetSettings === 'waiting') {
        heldGetSettings = msg;
        return;
      }
      answerSettingsControl(msg);
      return;
    }
    if (msg && msg.type === 'control_request' && msg.request && msg.request.subtype === 'interrupt') {
      // Acknowledge the interrupt so the query wrapper unblocks, then emit a non-success result
      // to signal turn cancellation (mirrors real Claude Code behavior closely enough for tests).
      if (logPath) fs.appendFileSync(logPath, JSON.stringify({ kind: 'control', subtype: 'interrupt' }) + '\\n', 'utf8');
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success' } }) + '\\n');
      if (heldGetSettings && heldGetSettings !== 'waiting') {
        answerSettingsControl(heldGetSettings);
        heldGetSettings = null;
      }
      if (hangTurn && turn === 1) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', result: 'INTERRUPTED', num_turns: turn, total_cost_usd: 0, usage: undefined, duration_ms: 1, duration_api_ms: 1, is_error: true, session_id: sessionId }) + '\\n');
      }
      return;
	    }
	    if (!msg || msg.type !== 'user') return;
	    turn += 1;
	    if (logPath) {
	      fs.appendFileSync(
	        logPath,
	        JSON.stringify({ kind: 'user', turn, content: msg.message && msg.message.content }) + '\\n',
	        'utf8',
	      );
	    }
    if (compactTurn && turn === 1 && !didCompact) {
      didCompact = true;
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'bada10c6-9299-4c45-abc4-91db9c0f935d' }) + '\\n');
      return;
    }
	    if (toolName && turn === 1) {
	      // Request permission for a tool call; the parent will reply with a control_response.
	      const reqId = 'req-1';
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: reqId, request: { subtype: 'can_use_tool', tool_name: toolName, input: toolInput, tool_use_id: 'toolu_permission_1' } }) + '\\n');
    const onControl = (line2) => {
      const t2 = String(line2 || '').trim();
      if (!t2) return;
      let msg2;
      try { msg2 = JSON.parse(t2); } catch { return; }
      if (!msg2 || msg2.type !== 'control_response') return;
      if (!msg2.response || msg2.response.request_id !== reqId) return;
      rl.off('line', onControl);
      const behavior = msg2.response.response && msg2.response.response.behavior;
      const label = behavior === 'allow' ? 'TOOL_ALLOWED' : 'TOOL_DENIED';
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: label }] } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: emitUsage ? 0.123 : 0, usage: emitUsage ? { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } : undefined, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
    };
    rl.on('line', onControl);
    return;
  }
  if (hangTurn && turn === 1) {
    return;
  }
  if (emitToolFlow && turn === 1) {
    const toolUseId = 'toolu_1';
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'README.md' } }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'OK' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'TOOL_DONE' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: emitUsage ? 0.123 : 0, usage: emitUsage ? { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } : undefined, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
    return;
  }
  if (emitWriteFlow && turn === 1) {
    const toolUseId = 'toolu_write_1';
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' } }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'OK', is_error: false }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'WRITE_DONE' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: emitUsage ? 0.123 : 0, usage: emitUsage ? { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } : undefined, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
    return;
  }
  if (emitDiffFlow && turn === 1) {
    const toolUseId = 'toolu_diff_1';
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Diff', input: { files: [{ file_path: 'src/diff.ts', oldText: 'before', newText: 'after' }] } }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'OK', is_error: false }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DIFF_DONE' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: emitUsage ? 0.123 : 0, usage: emitUsage ? { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } : undefined, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
    return;
  }
  if (multiChunk) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn + '_A' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn + '_B' }] } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_ASSIST_' + turn }] } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE_' + turn, num_turns: turn, total_cost_usd: emitUsage ? 0.123 : 0, usage: emitUsage ? { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } : undefined, duration_ms: 1, duration_api_ms: 1, is_error: false, session_id: sessionId }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;
}

type BackendRunContext = {
  backend: {
    onMessage: (handler: (msg: unknown) => void) => void;
    startSession: () => Promise<{ sessionId: string }>;
    sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
    sendSteerPrompt: (sessionId: string, prompt: string) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    dispose: () => Promise<void>;
  };
  dir: string;
  logPath: string;
};

async function withFakeClaudeBackend(
    params: Readonly<{
    dirPrefix: string;
    permissionPolicy: 'no_tools' | 'read_only' | 'workspace_write';
    toolName?: string;
    toolInput?: Record<string, unknown>;
    hangTurn?: boolean;
    compactTurn?: boolean;
    multiChunk?: boolean;
    emitToolFlow?: boolean;
    emitWriteFlow?: boolean;
    emitDiffFlow?: boolean;
    emitUsage?: boolean;
    modelId?: string;
    includeLogPath?: boolean;
    env?: Record<string, string>;
  }>,
  run: (ctx: BackendRunContext) => Promise<void>,
): Promise<void> {
  let dir: string | null = null;
  let backend: BackendRunContext['backend'] | null = null;
  const logPath = params.includeLogPath === false ? '' : 'argv.jsonl';

  try {
    dir = await mkdtemp(join(tmpdir(), params.dirPrefix));
    const entry = join(dir, 'fake-claude.cjs');
    await writeFile(entry, createFakeClaudeEntrypointSource(), 'utf8');

    process.env.HAPPIER_CLAUDE_PATH = entry;
    if (params.includeLogPath === false) {
      delete process.env.FAKE_CLAUDE_LOG_PATH;
    } else {
      process.env.FAKE_CLAUDE_LOG_PATH = join(dir, logPath);
    }
    if (params.toolName) {
      process.env.FAKE_CLAUDE_TOOL_NAME = params.toolName;
    } else {
      delete process.env.FAKE_CLAUDE_TOOL_NAME;
    }
    if (params.toolInput) {
      process.env.FAKE_CLAUDE_TOOL_INPUT = JSON.stringify(params.toolInput);
    } else {
      delete process.env.FAKE_CLAUDE_TOOL_INPUT;
    }
    process.env.FAKE_CLAUDE_HANG_TURN = params.hangTurn ? '1' : '0';
    process.env.FAKE_CLAUDE_COMPACT_TURN = params.compactTurn ? '1' : '0';
    process.env.FAKE_CLAUDE_MULTI_CHUNK = params.multiChunk ? '1' : '0';
    process.env.FAKE_CLAUDE_EMIT_TOOL_FLOW = params.emitToolFlow ? '1' : '0';
    process.env.FAKE_CLAUDE_EMIT_WRITE_FLOW = params.emitWriteFlow ? '1' : '0';
    process.env.FAKE_CLAUDE_EMIT_DIFF_FLOW = params.emitDiffFlow ? '1' : '0';
    process.env.FAKE_CLAUDE_EMIT_USAGE = params.emitUsage ? '1' : '0';

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    backend = new ClaudeSdkAgentBackend({
      cwd: dir,
      modelId: params.modelId ?? 'chat-model',
      permissionHandler: createExecutionRunPermissionHandler({
        backendId: 'claude',
        permissionMode: params.permissionPolicy,
      }),
      env: params.env,
    });

    await run({
      backend,
      dir,
      logPath: params.includeLogPath === false ? '' : join(dir, logPath),
    });
  } finally {
    if (backend) {
      try {
        await backend.dispose();
      } catch {
        // Best-effort dispose in tests.
      }
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

describe('ClaudeSdkAgentBackend', () => {
  const originalClaudePath = process.env.HAPPIER_CLAUDE_PATH;
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    vi.useRealTimers();
    if (originalClaudePath === undefined) {
      delete process.env.HAPPIER_CLAUDE_PATH;
    } else {
      process.env.HAPPIER_CLAUDE_PATH = originalClaudePath;
    }
    delete process.env.FAKE_CLAUDE_LOG_PATH;
    delete process.env.FAKE_CLAUDE_TOOL_NAME;
    delete process.env.FAKE_CLAUDE_TOOL_INPUT;
    delete process.env.FAKE_CLAUDE_HANG_TURN;
    delete process.env.FAKE_CLAUDE_COMPACT_TURN;
    delete process.env.FAKE_CLAUDE_MULTI_CHUNK;
    delete process.env.FAKE_CLAUDE_EMIT_TOOL_FLOW;
    delete process.env.FAKE_CLAUDE_EMIT_WRITE_FLOW;
    delete process.env.FAKE_CLAUDE_EMIT_DIFF_FLOW;
    delete process.env.FAKE_CLAUDE_EMIT_USAGE;
    if (originalDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = originalDebug;
    }
  });

  it('uses the exact Claude tool-use id and releases its pending decision when cancelled', async () => {
    let resolvePermission!: (result: { decision: 'abort' }) => void;
    const handleToolCall = vi.fn(() => new Promise<{ decision: 'abort' }>((resolve) => {
      resolvePermission = resolve;
    }));
    const cancelPendingRequest = vi.fn(() => {
      resolvePermission({ decision: 'abort' });
      return true;
    });
    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: process.cwd(),
      modelId: 'chat-model',
      permissionHandler: { handleToolCall, cancelPendingRequest },
    });
    const controller = new AbortController();
    const pending = (backend as any).buildCanCallTool()('Bash', { command: 'git status' }, {
      signal: controller.signal,
      toolUseId: 'toolu_permission_1',
    });

    await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalled());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(handleToolCall).toHaveBeenCalledWith('toolu_permission_1', 'Bash', { command: 'git status' });
    expect(cancelPendingRequest).toHaveBeenCalledWith('toolu_permission_1', 'Claude permission request cancelled');
  });

  it('holds provider membership until the exact typed session/task terminal and ignores tool-result inference', async () => {
    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: process.cwd(),
      modelId: 'chat-model',
      permissionHandler: createExecutionRunPermissionHandler({
        backendId: 'claude',
        permissionMode: 'no_tools',
      }),
    });
    const statuses: string[] = [];
    backend.onMessage((message) => {
      if (message.type === 'status') statuses.push(message.status);
    });

    (backend as any).handleSdkMessage({
      type: 'system',
      subtype: 'task_started',
      session_id: 'session-a',
      task_id: 'task-1',
    });
    (backend as any).handleSdkMessage({
      type: 'user',
      toolUseResult: { backgroundTaskId: 'task-1', status: 'completed' },
      message: { role: 'user', content: [] },
    });
    (backend as any).handleSdkMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'session-b',
      task_id: 'task-1',
      status: 'completed',
    });

    expect(statuses).not.toContain('idle');

    (backend as any).handleSdkMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'session-a',
      task_id: 'task-1',
      status: 'completed',
    });

    expect(statuses.filter((status) => status === 'idle')).toHaveLength(1);
  });

  it('emits cumulative model-output fullText when Claude returns multiple assistant messages in a single turn', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-chunks-',
        permissionPolicy: 'no_tools',
        multiChunk: true,
      },
      async ({ backend }) => {
        const fullTexts: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            fullTexts.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();

        expect(fullTexts.length).toBeGreaterThan(0);
        const last = fullTexts[fullTexts.length - 1]!;
        expect(last).toContain('FAKE_ASSIST_1_A');
        expect(last).toContain('FAKE_ASSIST_1_B');
      },
    );
  });

  it('supports multi-turn sendPrompt and passes the model id through to the spawned process', async () => {
    // Keep unit tests quiet even if the parent env has DEBUG set.
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-',
        permissionPolicy: 'no_tools',
        modelId: 'chat-model',
      },
      async ({ backend, logPath }) => {
        const seen: string[] = [];
        const statuses: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
          if (msg.type === 'status' && typeof msg.status === 'string') {
            statuses.push(msg.status);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        await backend.sendPrompt(sessionId, 'again');
        await (backend as any).waitForResponseComplete?.();

        expect(seen.join(' ')).toContain('FAKE_ASSIST_1');
        expect(seen.join(' ')).toContain('FAKE_ASSIST_2');

        const argvLog = (await import('node:fs/promises')).readFile(logPath, 'utf8');
        expect(await argvLog).toContain('--model');
        expect(await argvLog).toContain('chat-model');

        expect(statuses.filter((s) => s === 'running')).toHaveLength(1);
      },
    );
  });

  it('launches a pinned execution-run model at its pinned effort with ultracode explicitly off', async () => {
    delete process.env.DEBUG;
    vi.stubEnv('HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES', '{"claude-opus-5-5":"medium"}');
    (await import('@/configuration')).reloadConfiguration();
    try {
      await withFakeClaudeBackend(
        { dirPrefix: 'happier-claude-sdk-pinned-', permissionPolicy: 'no_tools', modelId: 'claude-opus-5-5' },
        async ({ backend, logPath }) => {
          const { sessionId } = await backend.startSession();
          await backend.sendPrompt(sessionId, 'hi');
          await (backend as any).waitForResponseComplete?.();

          const argvLog = await (await import('node:fs/promises')).readFile(logPath, 'utf8');
          const argv = (JSON.parse(argvLog.trim().split('\n')[0] ?? '{}') as { argv: string[] }).argv;
          expect(argv[argv.indexOf('--effort') + 1]).toBe('medium');
          expect(JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')).toMatchObject({ ultracode: false });
        },
      );
    } finally {
      vi.unstubAllEnvs();
      (await import('@/configuration')).reloadConfiguration();
    }
  });

  describe('per-model effort pin bridge', () => {
    async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
      const raw = await (await import('node:fs/promises')).readFile(logPath, 'utf8');
      return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    function controlsAndPrompts(entries: Array<Record<string, unknown>>): string[] {
      return entries.flatMap((entry) => entry.kind === 'control'
        ? [`${String(entry.subtype)}${entry.settings ? `:${JSON.stringify(entry.settings)}` : ''}`]
        : entry.kind === 'user' ? [`prompt:${String(entry.content)}`] : []);
    }

    async function withOpusPinnedMedium(run: () => Promise<void>): Promise<void> {
      delete process.env.DEBUG;
      vi.stubEnv('HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES', '{"claude-opus-5-5":"medium"}');
      (await import('@/configuration')).reloadConfiguration();
      try {
        await run();
      } finally {
        vi.unstubAllEnvs();
        delete process.env.FAKE_CLAUDE_IGNORE_APPLY;
        (await import('@/configuration')).reloadConfiguration();
      }
    }

    it('applies and verifies the pinned effort for the native default model before each prompt', async () => {
      await withOpusPinnedMedium(() => withFakeClaudeBackend(
        { dirPrefix: 'happier-claude-sdk-default-pin-', permissionPolicy: 'no_tools', modelId: 'default' },
        async ({ backend, logPath }) => {
          const { sessionId } = await backend.startSession();
          await backend.sendPrompt(sessionId, 'first');
          await (backend as any).waitForResponseComplete?.();
          await backend.sendPrompt(sessionId, 'second');
          await (backend as any).waitForResponseComplete?.();

          expect(controlsAndPrompts(await readLog(logPath))).toEqual([
            'get_settings',
            'apply_flag_settings:{"effortLevel":"medium","ultracode":false}',
            'get_settings',
            'prompt:first',
            'get_settings',
            'prompt:second',
          ]);
        },
      ));
    });

    it('drops a prompt cancelled while its pinned effort is being checked, and runs the next one', async () => {
      await withOpusPinnedMedium(() => withFakeClaudeBackend(
        {
          dirPrefix: 'happier-claude-sdk-cancel-qualifying-',
          permissionPolicy: 'no_tools',
          modelId: 'default',
          env: { FAKE_CLAUDE_HOLD_FIRST_GET: '1', FAKE_CLAUDE_START_EFFORT: 'medium' },
        },
        async ({ backend, logPath }) => {
          const seen: string[] = [];
          backend.onMessage((msg: any) => {
            if (msg.type === 'model-output' && typeof msg.fullText === 'string') seen.push(msg.fullText);
          });
          const { sessionId } = await backend.startSession();

          const cancelled = backend.sendPrompt(sessionId, 'CANCELLED_PROMPT');
          const cancelledOutcome = cancelled.then(() => 'sent', (error: unknown) => `rejected:${(error as Error).message}`);
          // Cancel only once Claude Code holds the effort check (the prompt is not yet sent).
          const { readFile } = await import('node:fs/promises');
          while (!(await readFile(logPath, 'utf8').catch(() => '')).includes('"get_settings"')) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await backend.cancel(sessionId);

          expect(await cancelledOutcome).toBe('rejected:Turn cancelled');
          await backend.sendPrompt(sessionId, 'KEPT_PROMPT');
          await (backend as any).waitForResponseComplete();

          const events = controlsAndPrompts(await readLog(logPath));
          expect(events.filter((event) => event.startsWith('prompt:'))).toEqual(['prompt:KEPT_PROMPT']);
          expect(events.indexOf('interrupt')).toBeLessThan(events.indexOf('prompt:KEPT_PROMPT'));
          expect(seen.join(' ')).toContain('FAKE_ASSIST_1');
        },
      ));
    });

    it('rejects the prompt unsent when Claude Code does not adopt the pin', async () => {
      await withOpusPinnedMedium(() => withFakeClaudeBackend(
        { dirPrefix: 'happier-claude-sdk-ignored-pin-', permissionPolicy: 'no_tools', modelId: 'default' },
        async ({ backend, logPath }) => {
          process.env.FAKE_CLAUDE_IGNORE_APPLY = '1';
          const { sessionId } = await backend.startSession();

          await expect(backend.sendPrompt(sessionId, 'first')).rejects.toThrow(/did not adopt the pinned effort medium/);
          expect(controlsAndPrompts(await readLog(logPath)).filter((event) => event.startsWith('prompt:'))).toEqual([]);
        },
      ));
    });
  });

  it('refuses to start an execution run under a malformed effort policy before spawning Claude', async () => {
    delete process.env.DEBUG;
    vi.stubEnv('HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES', '{"claude-opus-5-5":"turbo"}');
    (await import('@/configuration')).reloadConfiguration();
    try {
      await withFakeClaudeBackend(
        { dirPrefix: 'happier-claude-sdk-malformed-', permissionPolicy: 'no_tools', modelId: 'claude-opus-5-5' },
        async ({ backend, logPath }) => {
          await expect(backend.startSession()).rejects.toThrow(/HAPPIER_CLAUDE_MODEL_EFFORT_OVERRIDES/);
          await expect((await import('node:fs/promises')).access(logPath)).rejects.toThrow();
        },
      );
    } finally {
      vi.unstubAllEnvs();
      (await import('@/configuration')).reloadConfiguration();
    }
  });

  it('passes explicit env overrides through to the spawned process', async () => {
    delete process.env.DEBUG;

    const previousState = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = '/tmp/xdg-state-parent';

      await withFakeClaudeBackend(
        {
          dirPrefix: 'happier-claude-sdk-env-',
          permissionPolicy: 'no_tools',
          env: {
            XDG_STATE_HOME: '/tmp/xdg-state-override',
          },
        },
        async ({ backend, logPath }) => {
          const { sessionId } = await backend.startSession();
          await backend.sendPrompt(sessionId, 'hi');
          await (backend as any).waitForResponseComplete?.();

          const argvLog = await (await import('node:fs/promises')).readFile(logPath, 'utf8');
          const firstLine = argvLog.trim().split('\n')[0] ?? '';
          const parsed = JSON.parse(firstLine) as any;
          expect(parsed.env?.XDG_STATE_HOME).toBe('/tmp/xdg-state-override');
        },
      );
    } finally {
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
    }
  });

  it('does not append hidden change-title instructions to user prompts', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-title-',
        permissionPolicy: 'no_tools',
      },
      async ({ backend, logPath }) => {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hello');
        await (backend as any).waitForResponseComplete?.();
        await backend.sendPrompt(sessionId, 'again');
        await (backend as any).waitForResponseComplete?.();

        const raw = await (await import('node:fs/promises')).readFile(logPath, 'utf8');
        const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const second = JSON.parse(lines[1] ?? 'null') as any;
        const third = JSON.parse(lines[2] ?? 'null') as any;
        expect(second).toMatchObject({ kind: 'user', turn: 1 });
        expect(String(second?.content ?? '')).toBe('hello');
        expect(String(second?.content ?? '')).not.toContain(CHANGE_TITLE_INSTRUCTION);
        expect(third).toMatchObject({ kind: 'user', turn: 2 });
        expect(String(third?.content ?? '')).toBe('again');
      },
    );
  });

  it('emits token-count telemetry when Claude result includes usage and cost', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-usage-',
        permissionPolicy: 'no_tools',
        emitUsage: true,
      },
      async ({ backend }) => {
        const tokens: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'token-count') tokens.push(msg);
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();

        expect(tokens.length).toBeGreaterThan(0);
        const last = tokens[tokens.length - 1] as any;
        expect(last.input_tokens).toBe(11);
        expect(last.output_tokens).toBe(22);
        expect(last.cache_read_input_tokens).toBe(3);
        expect(last.cache_creation_input_tokens).toBe(4);
        expect(last.cost).toBe(0.123);
      },
    );
  });

  it('allows ToolSearch in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'ToolSearch',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_ALLOWED');
      },
    );
  });

  it('denies ad-hoc bash inspection commands in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: { command: 'ls -la /tmp 2>/dev/null && echo \"---\" && ls /tmp 2>/dev/null' },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies bash loop inspection commands in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: {
          command:
            'for d in happier agent-os intent leeroy-wip tool-demo; do if [ -d "/Users/leeroy/$d/.git" ]; then echo "$d: git repo"; else echo "$d: not a git repo"; fi; done',
        },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies bash loop inspection commands with substitutions in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: {
          command: 'for d in /Users/leeroy/*/; do name=$(basename "$d"); if [ -d "$d/.git" ]; then echo "$name: git repo"; else echo "$name: not a git repo"; fi; done',
        },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies multiline bash inspection commands in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: {
          command: '# Check likely candidates more carefully\nfor p in /Users/leeroy/happier /Users/leeroy/leeroy-wip /Users/leeroy/agent-os; do\n  if [ -d \"$p/.git\" ]; then\n    echo \"GIT: $(basename $p)\"\n  elif [ -d \"$p\" ]; then\n    echo \"DIR: $(basename $p)\"\n  elif [ -f \"$p\" ]; then\n    echo \"FILE: $(basename $p)\"\n  fi\ndone',
        },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies bash commands that redirect to a writable file in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: { command: 'echo hi > /tmp/out.txt' },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies bash loop commands that perform write operations in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: {
          command: 'for f in alpha beta; do rm -rf "$f"; done',
        },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies bash loop command substitutions that perform write operations in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'Bash',
        toolInput: {
          command: 'for d in alpha beta; do name=$(rm -rf "$d"); echo "$name"; done',
        },
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies write-like tool calls in read_only policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'write_file',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('denies unknown tools in read_only policy (default-deny)', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'read_only',
        toolName: 'custom_tool',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_DENIED');
      },
    );
  });

  it('allows write-like tool calls in workspace_write policy', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'workspace_write',
        toolName: 'Bash',
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();
        expect(seen.join(' ')).toContain('TOOL_ALLOWED');
      },
    );
  });

  it('cancel interrupts a hanging turn so subsequent prompts can proceed', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-cancel-',
        permissionPolicy: 'no_tools',
        hangTurn: true,
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'this will hang');
        expect(typeof (backend as any).waitForResponseComplete).toBe('function');

        const firstCompletion = (backend as any).waitForResponseComplete();
        const firstOutcome = firstCompletion.then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        await backend.cancel(sessionId);

        await backend.sendPrompt(sessionId, 'second turn');
        await (backend as any).waitForResponseComplete();

        const settled = await Promise.race([
          firstOutcome,
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300)),
        ]);

        expect(settled.startsWith('rejected:')).toBe(true);
        expect(seen.join(' ')).toContain('FAKE_ASSIST_2');
      },
    );
  });

  it('allows standalone /compact session init to finish so queued prompts can continue without stopping the thread', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-compact-',
        permissionPolicy: 'no_tools',
        compactTurn: true,
      },
      async ({ backend }) => {
        const seen: string[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
            seen.push(msg.fullText);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'please compact');
        expect(typeof (backend as any).waitForResponseComplete).toBe('function');

        const firstCompletion = (backend as any).waitForResponseComplete().then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
        );

        const firstSettled = await firstCompletion;

        expect(firstSettled).toBe('resolved');

        await backend.sendPrompt(sessionId, 'follow-up after compaction');
        await (backend as any).waitForResponseComplete();

        expect(seen.join(' ')).toContain('FAKE_ASSIST_2');
      },
    );
  });

  it('sendSteerPrompt does not surface an interrupt-style error when a turn is in-flight', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-steer-',
        permissionPolicy: 'no_tools',
        hangTurn: true,
      },
      async ({ backend }) => {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'this will hang');
        expect(typeof (backend as any).waitForResponseComplete).toBe('function');

        const pending = (backend as any).waitForResponseComplete().then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        await backend.sendSteerPrompt(sessionId, 'steer message');

        const settled = await Promise.race([
          pending,
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
        ]);

        expect(settled.startsWith('rejected:')).toBe(false);
      },
    );
  });

  it('waitForResponseComplete without an explicit timeout does not default to a 120 second cap', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-no-default-timeout-',
        permissionPolicy: 'no_tools',
        hangTurn: true,
      },
      async ({ backend }) => {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'this will hang');
        expect(typeof (backend as any).waitForResponseComplete).toBe('function');

        vi.useFakeTimers();
        let outcome = 'pending';
        const completion = (backend as any).waitForResponseComplete().then(
          () => {
            outcome = 'resolved';
          },
          (error: unknown) => {
            outcome = `rejected:${error instanceof Error ? error.message : String(error)}`;
          },
        );

        await vi.advanceTimersByTimeAsync(120_001);
        await Promise.resolve();

        expect(outcome).toBe('pending');
        vi.useRealTimers();

        await backend.dispose();
        await completion;
        expect(outcome).toBe('rejected:Agent disposed');
      },
    );
  });

  it('rejects a pending turn when disposed', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-dispose-',
        permissionPolicy: 'no_tools',
        hangTurn: true,
      },
      async ({ backend }) => {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'this will hang');
        expect(typeof (backend as any).waitForResponseComplete).toBe('function');
        const pending = (backend as any).waitForResponseComplete().then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        await backend.dispose();

        const settled = await Promise.race([
          pending,
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300)),
        ]);
        expect(settled).toBe('rejected:Agent disposed');
      },
    );
  });

  it('rejects a pending turn when the Claude subprocess exits before completing the turn', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-exit-',
        permissionPolicy: 'no_tools',
      },
      async ({ backend, dir }) => {
        const crashingEntry = join(dir, 'fake-claude-crash.cjs');
        await writeFile(crashingEntry, "process.exit(17);\n", 'utf8');
        process.env.HAPPIER_CLAUDE_PATH = crashingEntry;

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');

        const settled = await Promise.race([
          (backend as any).waitForResponseComplete().then(
            () => 'resolved',
            (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
        ]);

        expect(settled).toContain('rejected:Claude Code process exited with code 17');
      },
    );
  });

  it('supports loadSession by passing --resume and emitting vendor_session_id', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-resume-',
        permissionPolicy: 'no_tools',
      },
      async ({ backend, logPath }) => {
        const events: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg?.type === 'event') events.push(msg);
        });

        const loaded = await (backend as any).loadSession('aada10c6-9299-4c45-abc4-91db9c0f935d');
        expect(loaded?.sessionId).toBe('1433467f-ff14-4292-b5b2-2aac77a808f0');

        await backend.sendPrompt(loaded.sessionId, 'hi');

        const argvLog = (await import('node:fs/promises')).readFile(logPath, 'utf8');
        const logText = await argvLog;
        expect(logText).toContain('--resume');
        expect(logText).toContain('aada10c6-9299-4c45-abc4-91db9c0f935d');

        expect(
          events.some(
            (e) => e?.name === 'vendor_session_id' && e?.payload && e.payload.sessionId === '1433467f-ff14-4292-b5b2-2aac77a808f0',
          ),
        ).toBe(true);
      },
    );
  });

  it('emits tool-call and tool-result messages when Claude returns tool_use/tool_result blocks', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-tools-',
        permissionPolicy: 'no_tools',
        emitToolFlow: true,
      },
      async ({ backend }) => {
        const toolCalls: any[] = [];
        const toolResults: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'tool-call') toolCalls.push(msg);
          if (msg.type === 'tool-result') toolResults.push(msg);
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'hi');
        await (backend as any).waitForResponseComplete?.();

        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toMatchObject({
          type: 'tool-call',
          toolName: 'read',
          callId: 'toolu_1',
        });

        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
          type: 'tool-result',
          toolName: 'read',
          callId: 'toolu_1',
          result: 'OK',
        });
      },
    );
  });

  it('emits a canonical Diff tool after a successful write-like turn', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-diff-',
        permissionPolicy: 'workspace_write',
        emitWriteFlow: true,
      },
      async ({ backend }) => {
        const events: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'tool-call' || msg.type === 'tool-result') {
            events.push(msg);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'edit the file');
        await (backend as any).waitForResponseComplete?.();

        const diffToolCall = events.find((event) => event.type === 'tool-call' && event.toolName === 'Diff');
        expect(diffToolCall).toBeTruthy();
        expect(diffToolCall?.args?._happier).toMatchObject({
          protocol: 'claude',
          provider: 'claude',
          canonicalToolName: 'Diff',
          sessionChangeScope: 'turn',
          source: 'provider_tool',
        });
        expect(diffToolCall?.args?.files).toEqual([
          expect.objectContaining({
            file_path: 'src/app.ts',
            oldText: 'old',
            newText: 'new',
          }),
        ]);

        const diffToolResult = events.find((event) => event.type === 'tool-result' && event.toolName === 'Diff');
        expect(diffToolResult).toMatchObject({
          type: 'tool-result',
          toolName: 'Diff',
          result: { status: 'completed' },
        });
      },
    );
  });

  it('normalizes an explicit Claude Diff tool into a canonical Diff turn artifact', async () => {
    delete process.env.DEBUG;

    await withFakeClaudeBackend(
      {
        dirPrefix: 'happier-claude-sdk-explicit-diff-',
        permissionPolicy: 'workspace_write',
        emitDiffFlow: true,
      },
      async ({ backend }) => {
        const events: any[] = [];
        backend.onMessage((msg: any) => {
          if (msg.type === 'tool-call' || msg.type === 'tool-result') {
            events.push(msg);
          }
        });

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'show me the diff');
        await (backend as any).waitForResponseComplete?.();

        const canonicalDiffCall = events.find((event) =>
          event.type === 'tool-call'
          && event.toolName === 'Diff'
          && event.args?._happier?.sessionChangeScope === 'turn'
        );
        expect(canonicalDiffCall).toBeTruthy();
        expect(canonicalDiffCall?.args?._happier).toMatchObject({
          protocol: 'claude',
          provider: 'claude',
          canonicalToolName: 'Diff',
          sessionChangeScope: 'turn',
          source: 'provider_tool',
        });
        expect(canonicalDiffCall?.args?.files).toEqual([
          expect.objectContaining({
            file_path: 'src/diff.ts',
            oldText: 'before',
            newText: 'after',
          }),
        ]);
        expect(events.filter((event) => event.type === 'tool-call' && event.toolName === 'Diff')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'tool-result' && event.toolName === 'Diff')).toHaveLength(1);
      },
    );
  });
});
