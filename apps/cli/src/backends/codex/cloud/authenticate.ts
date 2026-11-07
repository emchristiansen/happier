/**
 * Codex authentication helper
 * 
 * Provides OAuth authentication flow for OpenAI/ChatGPT
 * Returns full token object without storing or refreshing
 */

import { randomBytes } from 'crypto';
import {
  OPENAI_CODEX_OAUTH_AUTHORIZE_URL,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  OPENAI_CODEX_OAUTH_SCOPE,
} from '@happier-dev/agents';
import { openBrowser } from '@/ui/openBrowser';
import { generatePkceCodes } from '@/cloud/pkce';
import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';
import { startOauthPkceWithPasteFallback } from '@/cloud/oauthPkceWithPasteFallback';
import { promptInput } from '@/terminal/prompts/promptInput';

import { createCodexCloudAuthenticator } from './createCodexCloudAuthenticator';
import { authenticateCodexDevice, OPENAI_CODEX_DEVICE_VERIFICATION_URL } from './deviceAuth';
import {
  exchangeCodexAuthorizationGrant,
  type CodexAuthTokens,
} from './oauthExchange';
import { info, ok } from '@happier-dev/cli-common/output';

export type { CodexAuthTokens } from './oauthExchange';

// Configuration
const DEFAULT_PORT = 1455;

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(16).toString('hex');
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number
): Promise<CodexAuthTokens> {
    return await exchangeCodexAuthorizationGrant({
      code,
      verifier,
      redirectUri: `http://localhost:${port}/auth/callback`,
      now: Date.now(),
    });
}

export async function exchangeCodexAuthorizationCodeForTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number | null;
}>> {
  const redirectUrl = new URL(params.redirectUri);
  const port = Number.parseInt(redirectUrl.port || '80', 10);
  const tokens = await exchangeCodexAuthorizationGrant({
    code: params.code,
    verifier: params.verifier,
    redirectUri: params.redirectUri,
    now: params.now,
  });

  const expiresAt = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
    ? params.now + Math.trunc(tokens.expires_in) * 1000
    : null;

  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
    expiresAt,
  };
}

/**
 * Authenticate with Codex/OpenAI and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to CodexAuthTokens with all token information
 */
export async function authenticateCodex(opts?: CloudConnectAuthenticateOptions): Promise<CodexAuthTokens> {
  // console.log('🚀 Starting Codex authentication...');
  const authenticateDevice = async (params: { now: number; opts?: CloudConnectAuthenticateOptions }) => {
    const timeoutMs =
      typeof params.opts?.timeoutSeconds === 'number' && Number.isFinite(params.opts.timeoutSeconds)
        ? Math.max(1, Math.trunc(params.opts.timeoutSeconds)) * 1000
        : null;
    const startedAt = Date.now();
    const deadline = timeoutMs ? startedAt + timeoutMs : null;

    console.log('\nOpen this URL in a browser to authenticate:\n');
    console.log(OPENAI_CODEX_DEVICE_VERIFICATION_URL);

    const tokens = await authenticateCodexDevice({
      now: params.now,
      onUserCode: ({ userCode }) => {
        console.log('\nEnter this code:\n');
        console.log(userCode);
        console.log('');
        if (params.opts?.noOpen) return;
        void (async () => {
          try {
            await openBrowser(OPENAI_CODEX_DEVICE_VERIFICATION_URL);
          } catch {
            // ignore: URL is already printed
          }
        })();
      },
      sleep: async (ms) => {
        if (deadline && Date.now() + ms > deadline) {
          throw new Error('connect_oauth_timeout');
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });

    console.log(ok('Signed in to Codex'));
    return tokens;
  };

  const authenticatePkce = async (params: { mode: 'paste' | 'loopback'; opts?: CloudConnectAuthenticateOptions }) => {
    const timeoutMs =
      typeof params.opts?.timeoutSeconds === 'number' && Number.isFinite(params.opts.timeoutSeconds)
        ? Math.max(1, Math.trunc(params.opts.timeoutSeconds)) * 1000
        : undefined;

    const tokens = await startOauthPkceWithPasteFallback({
      mode: params.mode,
      defaultPort: DEFAULT_PORT,
      callbackPath: '/auth/callback',
      generateState,
      generatePkce: generatePkceCodes,
      timeoutMs,
      buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
        const params = [
          ['response_type', 'code'],
          ['client_id', OPENAI_CODEX_OAUTH_CLIENT_ID],
          ['redirect_uri', redirectUri],
          ['scope', OPENAI_CODEX_OAUTH_SCOPE],
          ['code_challenge', challenge],
          ['code_challenge_method', 'S256'],
          ['id_token_add_organizations', 'true'],
          ['codex_cli_simplified_flow', 'true'],
          ['state', state],
        ];
        const queryString = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
        return `${OPENAI_CODEX_OAUTH_AUTHORIZE_URL}?${queryString}`;
      },
      onAuthorizationUrl: ({ authorizationUrl }) => {
        console.log('\nOpen this URL in a browser to authenticate:\n');
        console.log(authorizationUrl);
        console.log('\nAfter login, paste the final redirected URL here.\n');
      },
      promptForPastedRedirectUrl: () => promptInput('Paste redirect URL: '),
      openAuthorizationUrl: async ({ authorizationUrl }) => {
        if (params.opts?.noOpen) return;
        console.log(info('Opening your browser to sign in'));
        console.log(`If browser doesn't open, visit:\n${authorizationUrl}\n`);
        await openBrowser(authorizationUrl);
      },
      exchangeCodeForTokens: ({ code, verifier, port }) => exchangeCodeForTokens(code, verifier, port),
      onSuccessResponse: ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
                        <html>
                        <body style="font-family: sans-serif; padding: 20px;">
                            <h2>✅ Authentication Successful!</h2>
                            <p>You can close this window and return to your terminal.</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </body>
                        </html>
                    `);
      },
    });

    console.log(ok('Signed in to Codex'));
    return tokens;
  };

  const run = createCodexCloudAuthenticator({
    now: () => Date.now(),
    authenticateDevice,
    authenticatePkce,
  });

  return await run(opts);
}
