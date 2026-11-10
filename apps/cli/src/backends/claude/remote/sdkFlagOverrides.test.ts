import { describe, expect, it } from 'vitest';

import { parseClaudeSdkFlagOverridesFromArgs } from './sdkFlagOverrides';

describe('parseClaudeSdkFlagOverridesFromArgs', () => {
  it('extracts supported scalar options', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--max-turns',
      '7',
      '--strict-mcp-config',
      '--append-system-prompt',
      'append me',
      '--system-prompt',
      'system me',
      '--model',
      'model-a',
      '--fallback-model',
      'model-b',
      '--effort',
      'medium',
    ]);

    expect(parsed).toMatchObject({
      maxTurns: 7,
      strictMcpConfig: true,
      appendSystemPrompt: 'append me',
      customSystemPrompt: 'system me',
      model: 'model-a',
      fallbackModel: 'model-b',
      effort: 'medium',
    });
  });

  it('ignores invalid max-turns values', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--max-turns',
      '-1',
    ]);

    expect(parsed.maxTurns).toBeUndefined();
  });

  it('ignores tool allow/deny flag overrides (do not hide user MCP tools)', () => {
    const parsed = parseClaudeSdkFlagOverridesFromArgs([
      '--allowedTools',
      'read,write',
      '--disallowedTools',
      'Edit',
    ]);

    expect((parsed as any).allowedTools).toBeUndefined();
    expect((parsed as any).disallowedTools).toBeUndefined();
  });

  it.each([
    {
      title: 'another flag\'s value that looks like a model flag',
      args: ['--model', 'claude-opus-5-5', '--name', '--model=claude-sonnet-4-6', 'prompt'],
      expected: { model: 'claude-opus-5-5' },
    },
    {
      title: 'a system prompt that looks like an effort flag',
      args: ['--model', 'claude-opus-5-5', '--system-prompt', '--effort=high', 'prompt'],
      expected: { model: 'claude-opus-5-5', customSystemPrompt: '--effort=high' },
    },
  ])('reads option values by flag arity: $title', ({ args, expected }) => {
    expect(parseClaudeSdkFlagOverridesFromArgs(args)).toEqual(expected);
  });
});
