import { describe, expect, it } from 'vitest';

import { classifyOpenCodeUsageLimitError } from './classifyOpenCodeUsageLimitError';
import { createOpenCodeConnectedServiceRuntimeAuthAdapter } from './createOpenCodeConnectedServiceRuntimeAuthAdapter';

describe('classifyOpenCodeUsageLimitError', () => {
  it.each(['GoUsageLimitError', 'FreeUsageLimitError'])('leaves allowance identity unknown when %s names no limit', (name) => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      error: { name },
    })?.providerLimitId).toBeNull();
  });
  it('parses retry-after-ms usage-limit payloads', () => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      error: {
        name: 'FreeUsageLimitError',
        headers: { 'retry-after-ms': '2500' },
      },
    })).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: 2500,
      quotaScope: 'account',
      providerLimitId: null,
    });
  });

  it('parses Go usage-limit metadata and action links', () => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      error: {
        name: 'GoUsageLimitError',
        metadata: { workspace: 'acme', limitName: 'daily_tokens' },
        headers: { 'retry-after': '5' },
        action: { url: 'https://opencode.ai/go' },
      },
    })).toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 5000,
      quotaScope: 'workspace',
      providerLimitId: 'daily_tokens',
      action: { kind: 'open_url', url: 'https://opencode.ai/go' },
    });
  });

  it('uses HTTP-date retry-after values when available', () => {
    const now = Date.parse('2026-05-17T12:00:00.000Z');

    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      now,
      error: {
        code: 'FreeUsageLimitError',
        headers: { 'retry-after': 'Sun, 17 May 2026 12:00:10 GMT' },
      },
    })).toMatchObject({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
  });

  it('parses provider body retry delays when retry headers are absent', () => {
    const now = Date.parse('2026-05-17T12:00:00.000Z');

    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      now,
      error: {
        name: 'GoUsageLimitError',
        retryDelay: '2m30s',
        metadata: { limitName: 'daily_tokens' },
      },
    })).toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 150_000,
      resetAtMs: now + 150_000,
      providerLimitId: 'daily_tokens',
    });
  });

  it('preserves retry metadata through the shared runtime auth classification shape', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai',
        activeProfileId: 'primary',
        groupId: 'team-pool',
      },
      error: {
        name: 'GoUsageLimitError',
        headers: { 'retry-after': '5' },
        metadata: { workspace: 'team-a', limitName: 'daily_tokens' },
        action: { url: 'https://opencode.ai/billing' },
      },
    })).toMatchObject({
      kind: 'rate_limit',
      limitCategory: 'rate_limit',
      serviceId: 'openai',
      profileId: 'primary',
      groupId: 'team-pool',
      retryAfterMs: 5_000,
      quotaScope: 'workspace',
      providerLimitId: 'daily_tokens',
      action: { kind: 'open_url', url: 'https://opencode.ai/billing' },
    });
  });

  it('keeps provider limit metadata out of capacity classifications', () => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      error: {
        name: 'ServerCapacityError',
        message: 'model capacity exhausted',
      },
    })).toBeNull();
  });

  it('does not classify arbitrary server failures', () => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      error: { message: 'server failed while loading config' },
    })).toBeNull();
  });
});
