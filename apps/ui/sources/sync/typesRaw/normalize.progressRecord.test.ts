import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { RawRecordSchema } from './schemas';

describe('typesRaw progress record handling', () => {
  it('keeps a tool answer delivery out of the visible transcript', () => {
    const raw = {
      role: 'user',
      content: { type: 'text', text: '> Choose an environment\n\nProduction' },
      meta: { happier: { kind: 'tool-answer-delivery.v1', payload: { toolCallId: 'question-1' } } },
    };

    expect(normalizeRawMessage('reply-message', 'reply-1', 1000, raw)).toBeNull();
  });

  it.each(['completed', 'refused'])('hides a stored Claude command lifecycle frame in state %s while preserving conversation neighbors', (state) => {
    // Raw stream-json shape observed with newer Claude runtimes. SDK 0.3.206 added this
    // frame; 0.3.238 added refused. Older Happier writers stored it as output data.
    const records = [
      { role: 'user', content: { type: 'text', text: 'hello' } },
      { role: 'agent', content: { type: 'output', data: {
        type: 'command_lifecycle', command_uuid: 'command-1', session_id: 'provider-session', state, uuid: 'lifecycle-1',
      } } },
      { role: 'agent', content: { type: 'output', data: {
        type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: [
          { type: 'text', text: 'reply' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
        ] },
      } } },
    ];
    const normalized = records.map((raw, index) => normalizeRawMessage(`message-${index}`, null, 1000 + index, raw));
    expect(normalized[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } });
    expect(normalized[1]).toBeNull();
    expect(normalized[2]).toMatchObject({ role: 'agent', content: [
      { type: 'text', text: 'reply' }, { type: 'tool-call', id: 'tool-1', name: 'Bash' },
    ] });
  });

  it('hides stored context-injection attachments classified as internal by the CLI', () => {
    expect(normalizeRawMessage('attachment', null, 1000, {
      role: 'agent', content: { type: 'output', data: {
        type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', stdout: '{}' },
      } },
    })).toBeNull();
  });

  it('accepts output progress records and drops them during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'progress',
          uuid: 'progress-1',
          status: 'running',
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-progress', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it('accepts Claude tool_progress heartbeat records and drops them during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'tool_progress',
          uuid: 'tool-progress-1',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          elapsed_time_seconds: 30,
          heartbeat: true,
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-tool-progress', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it('drops legacy Claude JSONL consumed-marker output records during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'claude_jsonl_consumed_marker',
          reason: 'prompt_echo_suppressed',
        },
      },
      meta: {
        source: 'cli',
        happier: { kind: 'claude_jsonl_consumed_marker.v1' },
      },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-consumed-marker', 'claude-jsonl:main:user:user-1', 1000, raw);
    expect(normalized).toBeNull();
  });

  it('accepts codex turn_aborted records and drops them during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'turn_aborted',
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-turn-aborted', null, 1000, raw);
    expect(normalized).toBeNull();
  });
});
