import { describe, expect, it } from 'vitest';

import { resolveClaudeUnifiedInitialHostLivenessTimeoutMs } from './runClaudeUnifiedTerminalSession';

describe('resolveClaudeUnifiedInitialHostLivenessTimeoutMs', () => {
  it('uses the complete startup-readiness timeout when no explicit test override is supplied', () => {
    expect(resolveClaudeUnifiedInitialHostLivenessTimeoutMs(undefined, 15_000)).toBe(15_000);
  });

  it('preserves an explicit liveness timeout override', () => {
    expect(resolveClaudeUnifiedInitialHostLivenessTimeoutMs(750, 15_000)).toBe(750);
  });
});
