import { describe, expect, it } from 'vitest';

import { normalizePiProviderFailure } from './piProviderFailureDiagnostic';

describe('normalizePiProviderFailure', () => {
  it('preserves and classifies a provider timeout reported by assistant message_end', () => {
    expect(normalizePiProviderFailure('assistant_message_end', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Request timed out.',
      },
    })).toEqual({
      classification: 'pi_provider_failure',
      code: 'provider_timeout',
      sanitizedPreview: 'Pi provider reported provider failure after prompt acceptance: message=Request timed out.',
    });
  });
});
