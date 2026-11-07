import {
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  OPENAI_CODEX_OAUTH_TOKEN_URL,
} from '@happier-dev/agents';

import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';

export interface CodexAuthTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  expires_in?: number;
  expires_at?: number | null;
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('Invalid JWT format');
  const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid JWT payload');
  }
  return parsed as Record<string, unknown>;
}

export function extractAccountId(idToken: string): string {
  const payload = parseJwtPayload(idToken);
  const direct = payload.chatgpt_account_id;
  if (typeof direct === 'string' && direct) return direct;
  const authClaim = payload['https://api.openai.com/auth'];
  if (!authClaim || typeof authClaim !== 'object' || Array.isArray(authClaim)) return '';
  const record = authClaim as Record<string, unknown>;
  const nested = record.chatgpt_account_id ?? record.account_id;
  return typeof nested === 'string' ? nested : '';
}

export async function exchangeCodexAuthorizationGrant(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
  fetcher?: typeof fetch;
}>): Promise<CodexAuthTokens> {
  const fetcher = params.fetcher ?? fetch;
  const response = await fetcher(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      statusText: response.statusText,
      body,
    }));
  }
  const data = (await response.json()) as Record<string, unknown>;
  const idToken = typeof data.id_token === 'string' ? data.id_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  if (!idToken || !refreshToken) throw new Error('Invalid OAuth token response');
  const accessToken = typeof data.access_token === 'string' && data.access_token
    ? data.access_token
    : idToken;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined;
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: extractAccountId(idToken),
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    expires_at: expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
      ? params.now + Math.trunc(expiresIn) * 1000
      : null,
  };
}

