import { describe, expect, it } from 'vitest';

import { getKnownUnavailableOpenCodeModel, parseOpenCodeModelId } from './openCodeModelParsing';

describe('openCodeModelParsing known unavailable replacements', () => {
  it('maps retired Anthropic legacy models to the current flagship Claude model', () => {
    expect(getKnownUnavailableOpenCodeModel({
      providerID: 'anthropic',
      modelID: 'claude-2.0',
      nowMs: Date.UTC(2026, 6, 1),
    })).toMatchObject({
      replacementModelId: 'claude-opus-5-5',
    });
  });

  it('returns null before the retirement timestamp', () => {
    expect(getKnownUnavailableOpenCodeModel({
      providerID: 'anthropic',
      modelID: 'claude-2.0',
      nowMs: Date.UTC(2025, 0, 1),
    })).toBeNull();
  });
});

describe('parseOpenCodeModelId', () => {
  it('parses provider/model from slash-delimited ids', () => {
    expect(parseOpenCodeModelId('anthropic/claude-opus-4-8')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-8',
    });
  });
});
