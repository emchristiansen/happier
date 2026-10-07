import { describe, expect, it } from 'vitest';

import { auggieTransport } from './transport';

const ctx = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 } as const;

describe('AuggieTransport determineToolName', () => {
  it('canonicalizes legacy change_title aliases even when toolName is provided directly', () => {
    expect(auggieTransport.determineToolName('happy__change_title', 'tool-1', {}, ctx)).toBe('change_title');
    expect(auggieTransport.determineToolName('mcp__happy__change_title', 'tool-2', {}, ctx)).toBe('change_title');
  });
});

describe('AuggieTransport handleStderr', () => {
  it('uses contextual auth evidence instead of broad authentication keywords', () => {
    const context = { activeToolCalls: new Set<string>(), hasActiveInvestigation: false };

    expect(auggieTransport.handleStderr('Authentication metadata row 401', context)).toEqual({
      message: null,
      suppress: false,
    });
    expect(auggieTransport.handleStderr('Token refresh failed: 401', context).message).toMatchObject({
      type: 'status',
      status: 'error',
    });
  });
});
