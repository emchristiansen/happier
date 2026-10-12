import { describe, expect, it } from 'vitest';

import { readClaudeActiveUnifiedTerminalHost } from './readClaudeActiveTerminalMode';

describe('readClaudeActiveUnifiedTerminalHost', () => {
  it('recognizes the persisted Herdr host during unified controller recovery', () => {
    expect(readClaudeActiveUnifiedTerminalHost({
      metadata: { terminal: { mode: 'herdr' } },
    })).toBe('herdr');
  });
});
