import { randomBytes } from 'node:crypto';
import { AGY_OAUTH_ALLOW_RAW_AUTHORIZATION_CODE, AGY_OAUTH_AUTHORIZE_URL, AGY_OAUTH_CALLBACK_URL, AGY_OAUTH_SCOPES, AGY_OAUTH_USERINFO_URL } from '@happier-dev/agents';
import { exchangeGoogleOauthAuthorizationCodeForTokens, type GoogleOauthTokens } from '@/cloud/googleOauthTokenExchange';
import { generatePkceCodes } from '@/cloud/pkce';
import { startOauthPkceWithPasteFallback } from '@/cloud/oauthPkceWithPasteFallback';
import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';
import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import { promptInput } from '@/terminal/prompts/promptInput';
import { openBrowser } from '@/ui/openBrowser';
import { info, ok, warn } from '@happier-dev/cli-common/output';

export type AgyAuthTokens = GoogleOauthTokens & Readonly<{
  providerEmail: string | null;
  providerAccountId: string | null;
  project_id?: string;
}>;

async function resolveAgyOauthIdentity(accessToken: string): Promise<Pick<AgyAuthTokens, 'providerEmail' | 'providerAccountId'>> {
  const missing = { providerEmail: null, providerAccountId: null };
  let response: Response;
  try {
    response = await fetch(AGY_OAUTH_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    console.log(warn('Google Antigravity account identity is unavailable. You can name the account after connecting.'));
    return missing;
  }
  if (response.status === 401) throw new Error('Google Antigravity access-token verification failed (401)');
  if (response.ok) {
    const data: unknown = await response.json().catch(() => null);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const identity = {
        providerEmail: typeof record.email === 'string' && record.email.trim() ? record.email : null,
        providerAccountId: typeof record.sub === 'string' && record.sub.trim() ? record.sub : null,
      };
      if (identity.providerEmail || identity.providerAccountId) return identity;
    }
  }
  console.log(warn('Google Antigravity account identity is unavailable. You can name the account after connecting.'));
  return missing;
}

export async function authenticateAgy(opts?: CloudConnectAuthenticateOptions): Promise<AgyAuthTokens> {
  console.log(info('Signing in to Google Antigravity'));
  const tokens = await startOauthPkceWithPasteFallback({
    mode: 'paste', defaultPort: 0, callbackPath: '/oauth-callback', pasteRedirectUri: AGY_OAUTH_CALLBACK_URL,
    allowRawAuthorizationCode: AGY_OAUTH_ALLOW_RAW_AUTHORIZATION_CODE,
    generateState: () => randomBytes(32).toString('hex'), generatePkce: generatePkceCodes,
    buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
      const config = resolveConnectedAccountOauthConfig('antigravity', process.env);
      return `${AGY_OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri,
        scope: AGY_OAUTH_SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      })}`;
    },
    onAuthorizationUrl: async ({ authorizationUrl }) => {
      console.log(`\nOpen this URL in a browser to authenticate:\n\n${authorizationUrl}\n`);
      if (!opts?.noOpen && !opts?.paste) await openBrowser(authorizationUrl);
    },
    promptForPastedRedirectUrl: async () => {
      // The registered HTTPS callback is a paste flow on local and remote machines.
      // Browser opening remains optional; no native keyring or ambient login is changed.
      return promptInput('Paste the Google Antigravity authorization code, redirect URL, or code#state: ');
    },
    exchangeCodeForTokens: async ({ code, verifier }) => {
      const result = await exchangeGoogleOauthAuthorizationCodeForTokens({ serviceId: 'antigravity', code, verifier, redirectUri: AGY_OAUTH_CALLBACK_URL });
      if (!result.refresh_token?.trim()) throw new Error('Google Antigravity OAuth did not return a refresh token');
      return result;
    },
  });
  const identity = await resolveAgyOauthIdentity(tokens.access_token);
  console.log(ok('Signed in to Google Antigravity'));
  return { ...tokens, ...identity };
}
