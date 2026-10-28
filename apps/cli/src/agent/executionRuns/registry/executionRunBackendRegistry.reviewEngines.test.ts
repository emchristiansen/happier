import { describe, expect, it } from 'vitest';

import { listNativeReviewEngines } from '@happier-dev/protocol';

import { getExecutionRunBackendFactory } from './executionRunBackendRegistry';

describe('executionRunBackendRegistry (review engines)', () => {
  it('registers Devin as an execution-run backend', () => {
    expect(getExecutionRunBackendFactory('devin')).toBeTruthy();
  });

  it('registers an execution run backend factory for every native review engine', () => {
    for (const engine of listNativeReviewEngines()) {
      expect(getExecutionRunBackendFactory(engine.id)).toBeTruthy();
    }
  });
});
