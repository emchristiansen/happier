import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';

export interface GoogleOauthTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/** Google installed-app form transport; each service retains its issuing-client configuration. */
export async function exchangeGoogleOauthAuthorizationCodeForTokens(params: Readonly<{
  serviceId: 'gemini' | 'antigravity';
  code: string;
  verifier: string;
  redirectUri: string;
}>): Promise<GoogleOauthTokens> {
  const config = resolveConnectedAccountOauthConfig(params.serviceId, process.env);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: config.clientId,
      client_secret: config.clientSecret ?? '', code: params.code,
      code_verifier: params.verifier, redirect_uri: params.redirectUri,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange', status: response.status, statusText: response.statusText, body,
    }));
  }
  const json: unknown = await response.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid OAuth token response');
  const data = json as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new Error('Missing OAuth access token');
  return {
    access_token: data.access_token,
    ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(typeof data.token_type === 'string' ? { token_type: data.token_type } : {}),
    ...(typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? { expires_in: data.expires_in } : {}),
    // RFC 6749 §5.1: an omitted scope retains this authorization's requested grants.
    ...(typeof data.scope === 'string' ? { scope: data.scope }
      : data.scope === undefined ? { scope: config.scopes.join(' ') } : {}),
    ...(typeof data.id_token === 'string' ? { id_token: data.id_token } : {}),
  };
}
