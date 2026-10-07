import { describe, expect, it } from 'vitest';

import { buildOpenCodeThinkingModelOptionsFromVariants } from './openCodeThinkingModelOption';

describe('buildOpenCodeThinkingModelOptionsFromVariants', () => {
  it('projects released V2 variant arrays into the canonical Thinking option', () => {
    expect(buildOpenCodeThinkingModelOptionsFromVariants([
      { id: 'low' },
      { id: 'high' },
    ], null)).toEqual([{
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    }]);
  });

  it('preserves V1 variant records and the current selection', () => {
    expect(buildOpenCodeThinkingModelOptionsFromVariants({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    }, 'low')).toEqual([{
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    }]);
  });
});
