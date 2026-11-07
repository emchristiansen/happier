import { describe, expect, it } from 'vitest';

import { formatAccountIdentity, formatRelayHost } from './describeSignedInIdentity';

describe('describeSignedInIdentity', () => {
  it('names the relay by host (with a non-default port), never the full URL', () => {
    expect(formatRelayHost('https://api.happier.dev/')).toBe('api.happier.dev');
    expect(formatRelayHost('http://127.0.0.1:3005')).toBe('127.0.0.1:3005');
    expect(formatRelayHost('https://user:secret@relay.example.test/base')).toBe('relay.example.test');
    expect(formatRelayHost('not a url')).toBe('not a url');
  });

  it('names the account by its readable label and a short id a person can compare with the app', () => {
    expect(formatAccountIdentity({ accountLabel: 'bea', accountId: 'cmf3k9x2p0000abcdefgh' })).toBe('bea (cmf3k9x2…)');
    expect(formatAccountIdentity({ accountLabel: null, accountId: 'cmf3k9x2p0000abcdefgh' })).toBe('cmf3k9x2…');
    expect(formatAccountIdentity({ accountLabel: 'bea', accountId: 'acct_1' })).toBe('bea (acct_1)');
    expect(formatAccountIdentity({ accountLabel: null, accountId: null })).toBeNull();
  });
});
