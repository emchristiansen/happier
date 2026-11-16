import { describe, expect, it } from 'vitest';

import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

const report = {
  kind: 'usage_limit', serviceId: 'claude-subscription', profileId: 'alpha', groupId: 'pool', groupGeneration: null,
  credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', resetsAtMs: null, planType: null, rateLimits: null,
  source: 'structured_provider_error',
};

describe('sanitizeConnectedServiceRuntimeFailureClassification per-session member-home marker', () => {
  it('keeps the runner marker through staging and the durable outbox', () => {
    expect(sanitizeConnectedServiceRuntimeFailureClassification({ ...report, perSessionMemberHome: true }))
      .toMatchObject({ groupId: 'pool', groupGeneration: null, perSessionMemberHome: true });
  });

  it.each([false, 'true', 1, null])('drops a marker that is not exactly true (%s)', (marker) => {
    expect(sanitizeConnectedServiceRuntimeFailureClassification({ ...report, perSessionMemberHome: marker }))
      .not.toHaveProperty('perSessionMemberHome');
  });
});
