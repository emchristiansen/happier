import { describe, expect, it, vi } from 'vitest';

import { startOauthPkceWithPasteFallback } from './oauthPkceWithPasteFallback';

describe('startOauthPkceWithPasteFallback', () => {
  it('uses a registered provider callback in paste mode and validates the returned state', async () => {
    const exchangeCodeForTokens = vi.fn(async () => ({ accessToken: 'selected' }));
    const tokens = await startOauthPkceWithPasteFallback({
      mode: 'paste', defaultPort: 0, callbackPath: '/oauth-callback',
      pasteRedirectUri: 'https://antigravity.google/oauth-callback',
      generateState: () => 'state', generatePkce: () => ({ verifier: 'verifier', challenge: 'challenge' }),
      buildAuthorizationUrl: ({ redirectUri }) => {
        expect(redirectUri).toBe('https://antigravity.google/oauth-callback');
        return 'https://accounts.google.com/authorize';
      },
      promptForPastedRedirectUrl: async () => 'https://antigravity.google/oauth-callback?code=code&state=state',
      exchangeCodeForTokens,
    });
    expect(tokens).toEqual({ accessToken: 'selected' });
    expect(exchangeCodeForTokens).toHaveBeenCalledWith({ code: 'code', verifier: 'verifier', state: 'state', port: 0 });
    await expect(startOauthPkceWithPasteFallback({
      mode: 'paste', defaultPort: 0, callbackPath: '/oauth-callback',
      pasteRedirectUri: 'https://antigravity.google/oauth-callback',
      generateState: () => 'state', generatePkce: () => ({ verifier: 'verifier', challenge: 'challenge' }),
      buildAuthorizationUrl: () => 'https://accounts.google.com/authorize',
      promptForPastedRedirectUrl: async () => 'code#wrong-state', exchangeCodeForTokens,
    })).rejects.toThrow('OAuth state mismatch');
  });
  it('finishes presenting a pasted authorization request before prompting for its response', async () => {
    let presented = false;
    await startOauthPkceWithPasteFallback({
      mode: 'paste', defaultPort: 0, callbackPath: '/oauth-callback',
      generateState: () => 'state', generatePkce: () => ({ verifier: 'verifier', challenge: 'challenge' }),
      buildAuthorizationUrl: () => 'https://accounts.google.com/authorize',
      onAuthorizationUrl: async () => { await Promise.resolve(); presented = true; },
      promptForPastedRedirectUrl: async () => { expect(presented).toBe(true); return 'code#state'; },
      exchangeCodeForTokens: async () => ({ accessToken: 'selected' }),
    });
  });
  it('uses paste mode without binding a loopback server', async () => {
    const exchangeCodeForTokens = vi.fn(async () => ({ accessToken: 't1' }));
    const startLoopback = vi.fn(async () => ({ accessToken: 'loopback' }));

    const tokens = await startOauthPkceWithPasteFallback({
      mode: 'paste',
      defaultPort: 1455,
      callbackPath: '/auth/callback',
      generateState: () => 'state-1',
      generatePkce: () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
      buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
        `https://example.com/oauth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&challenge=${challenge}`,
      promptForPastedRedirectUrl: async () =>
        'http://localhost:1455/auth/callback?code=auth-code-1&state=state-1',
      exchangeCodeForTokens,
      startLoopbackOauthPkceFlowFn: startLoopback,
      openAuthorizationUrl: async () => {
        throw new Error('should not open browser in paste mode');
      },
    });

    expect(tokens).toEqual({ accessToken: 't1' });
    expect(startLoopback).not.toHaveBeenCalled();
    expect(exchangeCodeForTokens).toHaveBeenCalledWith({
      code: 'auth-code-1',
      verifier: 'verifier-1',
      state: 'state-1',
      port: 1455,
    });
  });
});
