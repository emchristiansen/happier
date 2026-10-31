import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_SCOPES, GEMINI_CLI_OAUTH_SCOPES } from '@happier-dev/agents';
import { exchangeGoogleOauthAuthorizationCodeForTokens } from './googleOauthTokenExchange';

afterEach(() => vi.unstubAllGlobals());
describe('Google installed-app authorization grants', () => {
  it.each([
    ['antigravity', AGY_OAUTH_SCOPES], ['gemini', GEMINI_CLI_OAUTH_SCOPES],
  ] as const)('records requested grants when %s omits unchanged scope', async (serviceId, scopes) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })));
    const tokens = await exchangeGoogleOauthAuthorizationCodeForTokens({ serviceId, code: 'code', verifier: 'verifier', redirectUri: 'https://synthetic.test/callback' });
    expect(tokens.scope).toBe(scopes.join(' '));
  });
  it('preserves narrower grants explicitly returned by Google', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'synthetic-access', scope: 'email' })));
    const tokens = await exchangeGoogleOauthAuthorizationCodeForTokens({ serviceId: 'antigravity', code: 'code', verifier: 'verifier', redirectUri: 'https://synthetic.test/callback' });
    expect(tokens.scope).toBe('email');
  });
});
