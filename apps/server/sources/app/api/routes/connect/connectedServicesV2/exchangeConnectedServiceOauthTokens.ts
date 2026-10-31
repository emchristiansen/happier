import { randomBytes } from "node:crypto";

import {
    sealBoxBundle,
    decodeBase64,
    encodeBase64,
    BOX_BUNDLE_PUBLIC_KEY_BYTES,
    type ConnectedServiceId,
    CONNECTED_SERVICE_ERROR_CODES,
} from "@happier-dev/protocol";
import {
    AGY_OAUTH_CALLBACK_URL,
    AGY_OAUTH_SCOPES,
    AGY_OAUTH_USERINFO_URL,
    GEMINI_CLI_OAUTH_SCOPES,
    CLAUDE_OAUTH_PROFILE_BETA_HEADER,
    CLAUDE_OAUTH_PROFILE_URL,
    normalizeClaudeOauthProfileEntitlement,
} from "@happier-dev/agents";
import { parseIntEnv } from "@/config/env";
import { warn } from "@/utils/logging/log";
import { assertNonEmptyString } from "./connectValueParsers";
import {
    extractOpenAiCodexAccountId,
    extractOpenAiCodexEmail,
} from "./openaiCodex/openaiCodexIdTokenClaims";
import {
    resolveAgyOauthClientId,
    resolveAgyOauthClientSecret,
    resolveAgyOauthTokenUrl,
    resolveClaudeSubscriptionOauthClientId,
    resolveClaudeSubscriptionOauthTokenUrl,
    resolveGeminiOauthClientId,
    resolveGeminiOauthClientSecret,
    resolveGeminiOauthTokenUrl,
    resolveOpenAiCodexOauthClientId,
    resolveOpenAiCodexOauthTokenUrl,
} from "./oauthConfig";

export class ConnectedServiceOauthTimeoutError extends Error {
    constructor() {
        super("Token exchange timed out");
        this.name = "ConnectedServiceOauthTimeoutError";
    }
}

export class ConnectedServiceOauthStateMismatchError extends Error {
    constructor() {
        super("OAuth state mismatch");
        this.name = "ConnectedServiceOauthStateMismatchError";
    }
}

export type ConnectedServiceOauthExchangeErrorCode =
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient
    | typeof CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken;

export class ConnectedServiceOauthExchangeError extends Error {
    constructor(
        public readonly errorCode: ConnectedServiceOauthExchangeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ConnectedServiceOauthExchangeError";
    }
}

type OauthExchangeInput = Readonly<{
    serviceId: ConnectedServiceId;
    publicKeyB64Url: string;
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string | null;
    now: number;
    fetcher?: typeof fetch;
}>;

type OauthExchangePayload = Readonly<{
    serviceId: ConnectedServiceId;
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope: string | null;
    tokenType: string | null;
    providerEmail: string | null;
    providerAccountId: string | null;
    expiresAt: number | null;
    raw: unknown;
}>;

function parseRecipientPublicKey(publicKeyB64Url: string): Uint8Array {
    const bytes = decodeBase64(publicKeyB64Url, "base64url");
    if (bytes.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
        throw new Error(`Invalid publicKey length: ${bytes.length}`);
    }
    return bytes;
}

function resolveOauthExchangeTimeoutMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS, 10_000, { min: 1_000, max: 60_000 });
}

function createFetchWithTimeout(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
    return async (input: any, init?: any) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetcher(input, { ...(init ?? {}), signal: controller.signal });
        } catch (error) {
            const name = error && typeof error === "object" && "name" in (error as any) ? String((error as any).name) : "";
            if (name === "AbortError") {
                throw new ConnectedServiceOauthTimeoutError();
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };
}

async function exchangeOpenAiCodex(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const clientId = resolveOpenAiCodexOauthClientId(process.env);
    const tokenUrl = resolveOpenAiCodexOauthTokenUrl(process.env);

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: params.code,
            code_verifier: params.verifier,
            redirect_uri: params.redirectUri,
        }),
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = (await response.json()) as any;
    const idToken = typeof json?.id_token === "string" ? json.id_token : null;
    const accessToken = typeof json?.access_token === "string" ? json.access_token : idToken;
    const refreshToken = assertNonEmptyString(json?.refresh_token, "refresh_token");
    const providerAccountId = extractOpenAiCodexAccountId(idToken);
    const providerEmail = extractOpenAiCodexEmail(idToken);

    const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    return {
        serviceId: "openai-codex",
        accessToken: assertNonEmptyString(accessToken, "access_token"),
        refreshToken,
        idToken,
        scope: null,
        tokenType: null,
        providerEmail,
        providerAccountId,
        expiresAt,
        raw: json,
    };
}

async function exchangeGoogleInstalledApp(params: Readonly<{
    serviceId: 'gemini' | 'antigravity';
    code: string;
    verifier: string;
    redirectUri: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const isAgy = params.serviceId === 'antigravity';
    if (isAgy && params.redirectUri !== AGY_OAUTH_CALLBACK_URL) {
        throw new ConnectedServiceOauthExchangeError(CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed, 'Unregistered Antigravity OAuth redirect');
    }
    const clientId = isAgy ? resolveAgyOauthClientId() : resolveGeminiOauthClientId(process.env);
    const clientSecret = isAgy ? resolveAgyOauthClientSecret() : resolveGeminiOauthClientSecret(process.env);
    const tokenUrl = isAgy ? resolveAgyOauthTokenUrl() : resolveGeminiOauthTokenUrl(process.env);
    const displayName = isAgy ? 'Antigravity' : 'Gemini';

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: clientSecret,
            code: params.code,
            code_verifier: params.verifier,
            redirect_uri: params.redirectUri,
        }),
    });
    if (!response.ok) {
        const json: unknown = await response.json().catch(() => null);
        const data = readRecord(json);
        const providerError = typeof data.error === 'string' ? data.error : '';
        const providerDescription = typeof data.error_description === 'string' ? data.error_description : '';
        if (providerError === "invalid_grant") {
            throw new ConnectedServiceOauthExchangeError(
                CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant,
                providerDescription || `${displayName} OAuth code is invalid or expired.`,
            );
        }
        if (providerError === "invalid_client") {
            throw new ConnectedServiceOauthExchangeError(
                CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient,
                providerDescription || `${displayName} OAuth client credentials are invalid.`,
            );
        }
        throw new ConnectedServiceOauthExchangeError(
            CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed,
            `Token exchange failed: ${response.status}`,
        );
    }

    const json = readRecord(await response.json());
    const accessToken = assertNonEmptyString(json?.access_token, "access_token");
    const refreshToken = typeof json?.refresh_token === "string" ? json.refresh_token : "";
    if (!refreshToken.trim()) {
        throw new ConnectedServiceOauthExchangeError(
            CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken,
            `${displayName} OAuth did not return a refresh token.`,
        );
    }
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) ? json.expires_in : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    const identity = isAgy ? await resolveAgyOauthIdentity({ accessToken, fetcher: params.fetcher }) : { providerEmail: null, providerAccountId: null };
    return {
        serviceId: params.serviceId,
        accessToken,
        refreshToken,
        idToken: typeof json?.id_token === "string" ? json.id_token : null,
        // RFC 6749 §5.1 permits omission when grants equal the requested scopes.
        scope: typeof json.scope === "string" ? json.scope : json.scope === undefined
            ? (isAgy ? AGY_OAUTH_SCOPES : GEMINI_CLI_OAUTH_SCOPES).join(' ')
            : null,
        tokenType: typeof json?.token_type === "string" ? json.token_type : null,
        ...identity,
        expiresAt,
        raw: json,
    };
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function resolveAgyOauthIdentity(params: Readonly<{ accessToken: string; fetcher: typeof fetch }>) {
    const missing = { providerEmail: null, providerAccountId: null };
    let response: Response;
    try {
        response = await params.fetcher(AGY_OAUTH_USERINFO_URL, { headers: { Authorization: `Bearer ${params.accessToken}` } });
    } catch {
        warn({ module: 'oauth', serviceId: 'antigravity' }, 'Optional account identity lookup unavailable');
        return missing;
    }
    if (response.status === 401) {
        throw new ConnectedServiceOauthExchangeError(CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed, 'Antigravity access-token verification failed (401)');
    }
    if (response.ok) {
        const data = readRecord(await response.json().catch(() => null));
        const identity = {
            providerEmail: typeof data.email === 'string' && data.email.trim() ? data.email : null,
            providerAccountId: typeof data.sub === 'string' && data.sub.trim() ? data.sub : null,
        };
        if (identity.providerEmail || identity.providerAccountId) return identity;
    }
    warn({ module: 'oauth', serviceId: 'antigravity', status: response.status }, 'Optional account identity lookup unavailable');
    return missing;
}

async function exchangeClaudeSubscription(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    state: string;
    now: number;
    fetcher: typeof fetch;
}>): Promise<OauthExchangePayload> {
    const clientId = resolveClaudeSubscriptionOauthClientId(process.env);
    const tokenUrl = resolveClaudeSubscriptionOauthTokenUrl(process.env);

    const response = await params.fetcher(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            code: params.code,
            redirect_uri: params.redirectUri,
            client_id: clientId,
            code_verifier: params.verifier,
            state: params.state,
        }),
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = (await response.json()) as any;
    const accessToken = assertNonEmptyString(json?.access_token, "access_token");
    const refreshToken = assertNonEmptyString(json?.refresh_token, "refresh_token");
    const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

    const providerEmail = typeof json?.account?.email_address === "string" ? json.account.email_address : null;
    const providerAccountId = typeof json?.account?.uuid === "string" ? json.account.uuid : null;
    const raw = await (async () => {
        let profileResponse: Response;
        try {
            profileResponse = await params.fetcher(CLAUDE_OAUTH_PROFILE_URL, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "anthropic-beta": CLAUDE_OAUTH_PROFILE_BETA_HEADER,
                },
            });
        } catch {
            // Entitlement metadata improves native materialization but is not required for a valid
            // OAuth credential. A transient profile lookup must not reject the completed login.
            return null;
        }
        if (profileResponse.status === 401) {
            throw new Error("Claude OAuth access-token verification failed (401)");
        }
        if (!profileResponse.ok) return null;
        try {
            return normalizeClaudeOauthProfileEntitlement(await profileResponse.json());
        } catch {
            return null;
        }
    })();

    return {
        serviceId: "claude-subscription",
        accessToken,
        refreshToken,
        idToken: null,
        scope: typeof json?.scope === "string" ? json.scope : null,
        tokenType: typeof json?.token_type === "string" ? json.token_type : null,
        providerEmail,
        providerAccountId,
        expiresAt,
        raw,
    };
}

export async function exchangeConnectedServiceOauthTokens(params: OauthExchangeInput): Promise<Readonly<{
    bundleB64Url: string;
}>> {
    const baseFetcher = params.fetcher ?? fetch;
    const timeoutMs = resolveOauthExchangeTimeoutMs(process.env);
    const fetcher = createFetchWithTimeout(baseFetcher, timeoutMs);
    const recipientPublicKey = parseRecipientPublicKey(params.publicKeyB64Url);

    const payload = await (async () => {
        if (params.serviceId === "openai-codex") {
            return await exchangeOpenAiCodex({
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                now: params.now,
                fetcher,
            });
        }
        if (params.serviceId === "anthropic") {
            throw new Error("Anthropic OAuth exchange is not supported. Use an API key instead.");
        }
        if (params.serviceId === "openai") {
            throw new Error("OpenAI API key service does not support OAuth exchange.");
        }
        if (params.serviceId === "claude-subscription") {
            const state = params.state?.trim() ?? "";
            if (!state) throw new ConnectedServiceOauthStateMismatchError();
            return await exchangeClaudeSubscription({
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                state,
                now: params.now,
                fetcher,
            });
        }
        if (params.serviceId === "gemini" || params.serviceId === 'antigravity') {
            return await exchangeGoogleInstalledApp({
                serviceId: params.serviceId,
                code: params.code,
                verifier: params.verifier,
                redirectUri: params.redirectUri,
                now: params.now,
                fetcher,
            });
        }
        throw new Error("Unsupported connected service");
    })();

    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const bundle = sealBoxBundle({
        plaintext,
        recipientPublicKey,
        randomBytes: (length) => randomBytes(length),
    });

    return { bundleB64Url: encodeBase64(bundle, "base64url") };
}
