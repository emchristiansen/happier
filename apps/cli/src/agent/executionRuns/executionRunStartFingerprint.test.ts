import { describe, expect, it } from 'vitest';

import { fingerprintExecutionRunStartRequest } from './executionRunStartFingerprint';

describe('fingerprintExecutionRunStartRequest', () => {
  it('ignores only top-level recovery metadata while preserving same-named intent input', () => {
    const base = {
      intent: 'delegate',
      intentInput: {
        startRequestId: 'domain-input-a',
        nested: { startRequestFingerprint: 'domain-fingerprint-a' },
      },
    };

    expect(fingerprintExecutionRunStartRequest({
      ...base,
      startRequestId: 'transport-attempt-a',
      startRequestFingerprint: 'transport-fingerprint-a',
    })).toBe(fingerprintExecutionRunStartRequest({
      ...base,
      startRequestId: 'transport-attempt-b',
      startRequestFingerprint: 'transport-fingerprint-b',
    }));

    expect(fingerprintExecutionRunStartRequest(base)).not.toBe(
      fingerprintExecutionRunStartRequest({
        ...base,
        intentInput: {
          ...base.intentInput,
          startRequestId: 'domain-input-b',
        },
      }),
    );
    expect(fingerprintExecutionRunStartRequest(base)).not.toBe(
      fingerprintExecutionRunStartRequest({
        ...base,
        intentInput: {
          ...base.intentInput,
          nested: { startRequestFingerprint: 'domain-fingerprint-b' },
        },
      }),
    );
  });
});
