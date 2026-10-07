import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendFactory } from './executionRunBackendRegistry';

describe('FX and Factory Droid execution-run registration', () => {
  it.each(['fx', 'droid'])('uses the generic ACP execution-run factory for %s', (agentId) => {
    expect(getExecutionRunBackendFactory(agentId)).toBeTypeOf('function');
  });
});
