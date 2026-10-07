/**
 * Gemini/Google authentication helper
 * 
 * Provides OAuth authentication flow for Google Gemini
 * Uses local callback server to handle OAuth redirect
 */

import { randomBytes } from 'crypto';
import {
    GEMINI_CLI_OAUTH_AUTHORIZE_URL,
    GEMINI_CLI_OAUTH_SCOPES,
} from '@happier-dev/agents';
import { generatePkceCodes } from '@/cloud/pkce';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { openBrowser } from '@/ui/openBrowser';
import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';
import { startOauthPkceWithPasteFallback } from '@/cloud/oauthPkceWithPasteFallback';
import { promptInput } from '@/terminal/prompts/promptInput';
import { resolveGeminiOauthClientId, resolveGeminiOauthClientSecret, resolveGeminiOauthTokenUrl } from '@/daemon/connectedServices/shared/oauthConfig';
import { dim, fail, info, ok } from '@happier-dev/cli-common/output';

export interface GeminiAuthTokens {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope: string;
    id_token?: string;
}

// Google OAuth Configuration for Gemini
const DEFAULT_PORT = 54545;
const SCOPES = GEMINI_CLI_OAUTH_SCOPES.join(' ');

export async function exchangeGeminiAuthorizationCodeForTokens(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
}>): Promise<GeminiAuthTokens> {
    const clientId = resolveGeminiOauthClientId(process.env);
    const clientSecret = resolveGeminiOauthClientSecret(process.env);
    const tokenUrl = resolveGeminiOauthTokenUrl(process.env);
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
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

    const data = (await response.json()) as GeminiAuthTokens;
    return data;
}

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number
): Promise<GeminiAuthTokens> {
    return exchangeGeminiAuthorizationCodeForTokens({
        code,
        verifier,
        redirectUri: `http://localhost:${port}/oauth2callback`,
    });
}

/**
 * Authenticate with Google Gemini and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to GeminiAuthTokens with all token information
 */
export async function authenticateGemini(opts?: CloudConnectAuthenticateOptions): Promise<GeminiAuthTokens> {
    console.log(info('Signing in to Google Gemini'));

    try {
        const mode = opts?.paste ? 'paste' : 'loopback';
        const timeoutMs = typeof opts?.timeoutSeconds === 'number' && Number.isFinite(opts.timeoutSeconds)
            ? Math.max(1, Math.trunc(opts.timeoutSeconds)) * 1000
            : undefined;

        const tokens = await startOauthPkceWithPasteFallback({
            mode,
            defaultPort: DEFAULT_PORT,
            callbackPath: '/oauth2callback',
            generateState,
            generatePkce: generatePkceCodes,
            timeoutMs,
            onPortResolved: ({ defaultPort, port, usedFallback }) => {
                if (usedFallback) {
                    console.log(`Port ${defaultPort} is in use, finding an available port...`);
                }
                console.log(dim(`  Using callback port ${port}`));
            },
            buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
                const clientId = resolveGeminiOauthClientId(process.env);
                const params = new URLSearchParams({
                    client_id: clientId,
                    response_type: 'code',
                    redirect_uri: redirectUri,
                    scope: SCOPES,
                    access_type: 'offline', // To get refresh token
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    state,
                    prompt: 'consent', // Force consent to get refresh token
                });
                return `${GEMINI_CLI_OAUTH_AUTHORIZE_URL}?${params}`;
            },
            onAuthorizationUrl: ({ authorizationUrl }) => {
                console.log('\nOpen this URL in a browser to authenticate:\n');
                console.log(authorizationUrl);
                console.log('\nAfter login, paste the final redirected URL here.\n');
            },
            promptForPastedRedirectUrl: () => promptInput('Paste redirect URL: '),
            openAuthorizationUrl: async ({ authorizationUrl }) => {
                if (opts?.noOpen) return;
                console.log(info('Opening your browser to sign in'));
                console.log('If browser doesn\'t open, visit this URL:');
                console.log(`\n${authorizationUrl}\n`);
                await openBrowser(authorizationUrl);
            },
            exchangeCodeForTokens: ({ code, verifier, port }) =>
                exchangeCodeForTokens(code, verifier, port),
            onCallbackErrorParam: ({ error, res }) => {
                res.writeHead(302, {
                    Location: 'https://developers.google.com/gemini-code-assist/auth_failure_gemini',
                });
                res.end();
                throw new Error(`Authentication error: ${error}`);
            },
            onSuccessResponse: ({ res }) => {
                res.writeHead(302, {
                    Location: 'https://developers.google.com/gemini-code-assist/auth_success_gemini',
                });
                res.end();
            },
        });
        
        console.log(ok('Signed in to Google Gemini'));
        
        return tokens;
    } catch (error) {
        console.error(fail('Could not sign in to Google'));
        throw error;
    }
}
