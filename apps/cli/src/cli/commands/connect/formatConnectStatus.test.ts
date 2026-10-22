import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { formatConnectStatusLines, type ConnectStatusVendor } from './formatConnectStatus';

const T1 = Date.UTC(2026, 9, 20, 8, 30, 0);
const T2 = Date.UTC(2026, 9, 21, 9, 45, 15);
const T3 = Date.UTC(2026, 9, 22, 10, 0, 0);
const T4 = Date.UTC(2026, 9, 19, 23, 59, 59);

function format(vendors: readonly ConnectStatusVendor[], profileFilter: string | null = null): string[] {
  return formatConnectStatusLines({ vendors, profileFilter }).map((line) => stripVTControlCharacters(line));
}

describe('formatConnectStatusLines', () => {
  it('prints every profile of a service, sorted by profile id, with all present fields', () => {
    const lines = format([{
      vendorDisplayName: 'OpenAI Codex',
      kind: 'services',
      services: [{
        serviceId: 'openai-codex',
        outcome: 'listed',
        // Server order is updatedAt desc, which means nothing to the reader.
        profiles: [
          { profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'work@example.com', expiresAt: T1 },
          { profileId: 'alt', status: 'needs_reauth', kind: 'oauth', providerEmail: 'alt@example.com' },
          { profileId: 'batch', status: 'refreshing', kind: 'token' },
        ],
      }],
    }]);

    expect(lines).toEqual([
      '  ✓  OpenAI Codex',
      '      openai-codex/alt: needs_reauth',
      '        kind: oauth',
      '        email: alt@example.com',
      '      openai-codex/batch: refreshing',
      '        kind: token',
      '      openai-codex/work: connected',
      '        kind: oauth',
      '        email: work@example.com',
      '        expires at: 2026-10-20T08:30:00.000Z',
    ]);
  });

  it('prints credential health fields in ISO UTC and omits absent ones', () => {
    const lines = format([{
      vendorDisplayName: 'Claude',
      kind: 'services',
      services: [{
        serviceId: 'claude-subscription',
        outcome: 'listed',
        profiles: [
          {
            profileId: 'main',
            status: 'refresh_failed_retryable',
            kind: 'oauth',
            providerEmail: null,
            expiresAt: null,
            health: {
              v: 1,
              status: 'refresh_failed_retryable',
              reconnectRequired: false,
              lastRefreshSuccessAt: T1,
              lastRefreshFailureAt: T2,
              lastRefreshFailureKind: 'network_error',
              providerHttpStatus: 503,
              providerErrorCode: 'overloaded',
              lastRuntimeAuthFailureAt: T3,
            },
          },
          {
            profileId: 'spare',
            status: 'needs_reauth',
            health: { v: 1, status: 'needs_reauth', reconnectRequired: true, lastRefreshFailureAt: T4 },
          },
          { profileId: 'bare', status: 'connected', kind: null, providerEmail: '', health: null },
        ],
      }],
    }]);

    expect(lines).toEqual([
      '  ✓  Claude',
      '      claude-subscription/bare: connected',
      '      claude-subscription/main: refresh_failed_retryable',
      '        kind: oauth',
      '        health: refresh_failed_retryable',
      '        reconnect required: no',
      '        last refresh success: 2026-10-20T08:30:00.000Z',
      '        last refresh failure: 2026-10-21T09:45:15.000Z',
      '        last refresh failure kind: network_error',
      '        provider http status: 503',
      '        provider error code: overloaded',
      '        last runtime auth failure: 2026-10-22T10:00:00.000Z',
      '      claude-subscription/spare: needs_reauth',
      '        health: needs_reauth',
      '        reconnect required: yes',
      '        last refresh failure: 2026-10-19T23:59:59.000Z',
    ]);
  });

  it('sorts by service id, then profile id, across a vendor with several services', () => {
    const lines = format([{
      vendorDisplayName: 'OpenAI Codex',
      kind: 'services',
      services: [
        { serviceId: 'openai-codex', outcome: 'listed', profiles: [{ profileId: 'b', status: 'connected' }, { profileId: 'a', status: 'refreshing' }] },
        { serviceId: 'openai', outcome: 'listed', profiles: [{ profileId: 'z', status: 'connected', kind: 'token' }] },
      ],
    }]);

    expect(lines).toEqual([
      '  ✓  OpenAI Codex',
      '      openai/z: connected',
      '        kind: token',
      '      openai-codex/a: refreshing',
      '      openai-codex/b: connected',
    ]);
  });

  it('shows needs_reauth-only vendors with a warning heading', () => {
    const lines = format([{
      vendorDisplayName: 'Gemini',
      kind: 'services',
      services: [{ serviceId: 'gemini', outcome: 'listed', profiles: [{ profileId: 'default', status: 'needs_reauth' }] }],
    }]);

    expect(lines).toEqual([
      '  ⚠️  Gemini',
      '      gemini/default: needs_reauth',
    ]);
  });

  it('keeps the not-connected, not-supported and unknown single-line cases', () => {
    const lines = format([
      { vendorDisplayName: 'Gemini', kind: 'services', services: [{ serviceId: 'gemini', outcome: 'listed', profiles: [] }] },
      { vendorDisplayName: 'Mystery', kind: 'unsupported' },
      { vendorDisplayName: 'Broken', kind: 'unresolved' },
      { vendorDisplayName: 'GitHub', kind: 'services', services: [{ serviceId: 'github', outcome: 'failed' }] },
      {
        vendorDisplayName: 'OpenAI Codex',
        kind: 'services',
        services: [
          { serviceId: 'openai-codex', outcome: 'failed' },
          { serviceId: 'openai', outcome: 'failed' },
        ],
      },
    ]);

    expect(lines).toEqual([
      '  ○  Gemini: not connected',
      '  ○  Mystery: not supported',
      '  ?  Broken: unknown (check failed)',
      '  ?  GitHub: unknown (check failed)',
      '  ?  OpenAI Codex: unknown (check failed)',
    ]);
  });

  it('reports a failed or empty service next to a listed one on a multi-service vendor', () => {
    const lines = format([
      {
        vendorDisplayName: 'OpenAI Codex',
        kind: 'services',
        services: [
          { serviceId: 'openai-codex', outcome: 'listed', profiles: [{ profileId: 'work', status: 'connected' }] },
          { serviceId: 'openai', outcome: 'failed' },
        ],
      },
      {
        vendorDisplayName: 'Claude',
        kind: 'services',
        services: [
          { serviceId: 'claude-subscription', outcome: 'listed', profiles: [] },
          { serviceId: 'anthropic', outcome: 'listed', profiles: [{ profileId: 'key', status: 'connected', kind: 'token' }] },
        ],
      },
    ]);

    expect(lines).toEqual([
      '  ✓  OpenAI Codex',
      '      openai: unknown (check failed)',
      '      openai-codex/work: connected',
      '  ✓  Claude',
      '      anthropic/key: connected',
      '        kind: token',
      '      claude-subscription: not connected',
    ]);
  });

  it('prints an out-of-range time as its raw number, marked, rather than a made-up date', () => {
    const lines = format([{
      vendorDisplayName: 'GitHub',
      kind: 'services',
      services: [{ serviceId: 'github', outcome: 'listed', profiles: [{ profileId: 'p', status: 'connected', expiresAt: 9e15 }] }],
    }]);

    expect(lines).toEqual([
      '  ✓  GitHub',
      '      github/p: connected',
      '        expires at: 9000000000000000 (not a valid time)',
    ]);
  });

  describe('with a profile filter', () => {
    const vendors: ConnectStatusVendor[] = [
      {
        vendorDisplayName: 'OpenAI Codex',
        kind: 'services',
        services: [
          {
            serviceId: 'openai-codex',
            outcome: 'listed',
            profiles: [
              { profileId: 'work', status: 'connected', providerEmail: 'w@example.com' },
              { profileId: 'work-2', status: 'connected' },
              { profileId: 'home', status: 'needs_reauth' },
            ],
          },
          { serviceId: 'openai', outcome: 'listed', profiles: [{ profileId: 'work', status: 'refreshing' }] },
        ],
      },
      {
        vendorDisplayName: 'Claude',
        kind: 'services',
        services: [{ serviceId: 'claude-subscription', outcome: 'listed', profiles: [{ profileId: 'home', status: 'connected' }] }],
      },
      { vendorDisplayName: 'Gemini', kind: 'services', services: [{ serviceId: 'gemini', outcome: 'listed', profiles: [] }] },
      { vendorDisplayName: 'GitHub', kind: 'services', services: [{ serviceId: 'github', outcome: 'failed' }] },
    ];

    it('prints only profiles with exactly that id and says which vendors have none', () => {
      expect(format(vendors, 'work')).toEqual([
        '  ✓  OpenAI Codex',
        '      openai/work: refreshing',
        '      openai-codex/work: connected',
        '        email: w@example.com',
        '  ○  Claude: no profile work',
        '  ○  Gemini: no profile work',
        '  ?  GitHub: unknown (check failed)',
      ]);
    });

    it('matches a vendor whose only matching profile needs re-auth', () => {
      expect(format(vendors, 'home')).toEqual([
        '  ⚠️  OpenAI Codex',
        '      openai: no profile home',
        '      openai-codex/home: needs_reauth',
        '  ✓  Claude',
        '      claude-subscription/home: connected',
        '  ○  Gemini: no profile home',
        '  ?  GitHub: unknown (check failed)',
      ]);
    });
  });
});
