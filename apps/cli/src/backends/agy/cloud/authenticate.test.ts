import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_CALLBACK_URL, AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_TOKEN_URL, AGY_OAUTH_USERINFO_URL } from '@happier-dev/agents';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { promptInput } from '@/terminal/prompts/promptInput';
import { agyCloudConnect } from './connect';

// Browser and terminal I/O are genuine OS boundaries; PKCE, callback parsing and record mapping remain real.
vi.mock('@/terminal/prompts/promptInput', () => ({ promptInput: vi.fn() }));
vi.mock('@/ui/openBrowser', () => ({ openBrowser: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Google Antigravity CLI connection', () => {
  function mockPastedCallback(response: 'url' | 'code' | 'code-state' | 'wrong-state' | 'foreign-url' | 'protocol-relative' | 'missing-state' | 'provider-error' = 'url') {
    let authorization: URL | undefined;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(promptInput).mockImplementation(async () => {
      const line = output.mock.calls.map(([value]) => String(value)).find((value) => value.includes('client_id='));
      const urlText = line?.match(/https:\/\/accounts\.google\.com\/\S+/)?.[0];
      if (!urlText) throw new Error('Authorization URL was not presented');
      const auth = new URL(urlText);
      authorization = auth;
      expect(auth.searchParams.get('redirect_uri')).toBe(AGY_OAUTH_CALLBACK_URL);
      expect(auth.searchParams.get('scope')?.split(' ')).toContain('https://www.googleapis.com/auth/aicode');
      const state = response === 'wrong-state' ? 'other-attempt' : auth.searchParams.get('state');
      if (response === 'code') return '4/0selected-code';
      if (response === 'code-state') return `selected-code#${state}`;
      if (response === 'foreign-url') return `https://foreign.example.test/oauth-callback?code=selected-code&state=${state}`;
      if (response === 'protocol-relative') return `//foreign.example.test/oauth-callback?ignored=x&code=selected-code&state=${state}`;
      if (response === 'missing-state') return `${AGY_OAUTH_CALLBACK_URL}?code=selected-code`;
      if (response === 'provider-error') return `${AGY_OAUTH_CALLBACK_URL}?code=selected-code&state=${state}&error=access_denied`;
      return `${AGY_OAUTH_CALLBACK_URL}?code=selected-code&state=${state}`;
    });
    return () => authorization;
  }

  it.each([
    { withOverrides: false, response: 'url' as const },
    { withOverrides: true, response: 'url' as const },
    { withOverrides: false, response: 'code' as const },
    { withOverrides: false, response: 'code-state' as const },
  ])('authenticates the current PKCE attempt from $response with registered issuer (overrides: $withOverrides)', async ({ withOverrides, response }) => {
    if (withOverrides) {
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_ID', 'machine-client');
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_SECRET', 'machine-client-secret');
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_TOKEN_URL', 'https://machine-issuer.example.test/token');
    }
    const authorization = mockPastedCallback(response);
    let tokenRequest: Readonly<{ url: string; body: URLSearchParams }> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === AGY_OAUTH_USERINFO_URL) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer selected-access');
        return Response.json({ sub: 'selected-account', email: 'selected@example.test' });
      }
      const body = new URLSearchParams(String(init?.body));
      tokenRequest = { url: String(input), body };
      expect(body.get('code')).toBe(response === 'code' ? '4/0selected-code' : 'selected-code');
      expect(body.get('redirect_uri')).toBe(AGY_OAUTH_CALLBACK_URL);
      const verifier = body.get('code_verifier');
      expect(verifier).toBeTruthy();
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(authorization()?.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'selected-access', refresh_token: 'selected-refresh', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetcher);
    const payload = await agyCloudConnect.authenticate({ noOpen: true });
    expect(authorization()?.searchParams.get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
    expect(tokenRequest?.url).toBe(AGY_OAUTH_TOKEN_URL);
    expect(tokenRequest?.body.get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
    expect(tokenRequest?.body.get('client_secret')).toBe(AGY_OAUTH_CLIENT_SECRET);
    const record = buildConnectedAccountOauthCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId: 'account-a', payload });
    expect(record).toMatchObject({
      serviceId: 'antigravity', profileId: 'account-a', expiresAt: 3601000,
      oauth: { accessToken: 'selected-access', refreshToken: 'selected-refresh', providerAccountId: 'selected-account', providerEmail: 'selected@example.test' },
    });
  });

  it('rejects another authorization attempt before token exchange', async () => {
    mockPastedCallback('wrong-state');
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(agyCloudConnect.authenticate({ noOpen: true })).rejects.toThrow('OAuth state mismatch');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['foreign-url', 'protocol-relative', 'missing-state', 'provider-error'] as const)('rejects a %s response before token exchange', async (response) => {
    mockPastedCallback(response);
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === AGY_OAUTH_USERINFO_URL
      ? Response.json({ sub: 'selected-account', email: 'selected@example.test' })
      : Response.json({ access_token: 'selected-access', refresh_token: 'selected-refresh' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(agyCloudConnect.authenticate({ noOpen: true })).rejects.toThrow(/Invalid OAuth redirect paste/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates canceled terminal input before credential effects', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cancellation = new Error('Canceled');
    vi.mocked(promptInput).mockRejectedValueOnce(cancellation);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(agyCloudConnect.authenticate({ noOpen: true })).rejects.toBe(cancellation);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 503])('handles userinfo status %i without substituting another account', async (status) => {
    mockPastedCallback();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input) === AGY_OAUTH_USERINFO_URL
      ? new Response('', { status })
      : Response.json({ access_token: 'selected-access', refresh_token: 'selected-refresh' })));
    const authentication = agyCloudConnect.authenticate({ noOpen: true });
    if (status === 401) await expect(authentication).rejects.toThrow(/verification failed/);
    else await expect(authentication).resolves.toMatchObject({ providerEmail: null, providerAccountId: null });
  });
});
